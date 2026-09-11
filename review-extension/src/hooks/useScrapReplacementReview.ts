/**
 * 功能：目标业务（青岛/长春报废置换 1.0）的字段优先审核编排。
 * 职责边界：只驱动 reviewSession 状态机和页面审核客户端，不渲染界面；
 * 人工选择只记录在前端内存，绝不篡改后端 MATCH/CONFLICT/INSUFFICIENT 结论；
 * 挂靠写入只在主体关系与三个辅助保护步骤全部 MATCH 且存在填写意图时执行一次；
 * 页面实例、URL、指纹、采集 ID 或 DOM 目标失效时立即停止后续标记和写入。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PageFillResult } from "../pageFillClient";
import {
  clearPageReviewMarkers,
  completePageReviewStep,
  showPageReviewStep,
  subscribePageReviewDecisions,
} from "../pageReviewClient.ts";
import type {
  PageReviewDecisionContext,
  PageReviewDecisionEvent,
  PageReviewResult,
} from "../pageReviewClient.ts";
import {
  completeMatchedStep,
  createReviewSession,
  currentStep,
  failReviewSession,
  recordReviewerDecision,
} from "../reviewSession.ts";
import type { ReviewerDecision, ReviewSessionState } from "../reviewSession.ts";
import { stepRequiresReviewerAction } from "../reviewSteps.ts";
import type {
  PageData,
  PageFillAction,
  ReviewResponse,
  ReviewStep,
} from "../types/review";
import type { ReviewWorkflow } from "./useReviewWorkflow";

/** 目标 Profile 显式三元组，镜像后端 review_step_routing.PAGE_INTERACTION_PROFILES。 */
const FIELD_FIRST_PROFILES: ReadonlySet<string> = new Set([
  "scrap_replacement|qingdao|1.0",
  "scrap_replacement|changchun|1.0",
]);

/** 只有青岛/长春报废置换 1.0 使用字段优先流程；过户、车源和一致性保持旧界面。 */
export function isFieldFirstProfile(
  review: Pick<ReviewResponse, "business_type" | "region" | "profile_version">,
): boolean {
  return FIELD_FIRST_PROFILES.has(
    `${review.business_type}|${review.region}|${review.profile_version}`,
  );
}

/**
 * 主体关系步骤的稳定后端 step_id（app/rules/affiliation_subject_checks.py 的
 * AFFILIATION-SUBJECT-001 经 review_step_routing 加 BUSINESS- 前缀）。
 * 只按 step_id 识别，绝不按中文 label 文本匹配。
 */
export const AFFILIATION_SUBJECT_STEP_ID = "BUSINESS-AFFILIATION-SUBJECT-001";

/** 三个辅助保护步骤的稳定后端 step_id；全部 MATCH 才允许挂靠写入。 */
export const AFFILIATION_PROTECTION_STEP_IDS: readonly string[] = Object.freeze([
  "BUSINESS-AFFILIATION-AUX-OWNER-TYPE",
  "BUSINESS-AFFILIATION-AUX-NEW-VIN",
  "BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME",
]);

const FALLBACK_SESSION_ERROR = "页面审核标记已失效，请重新审核";
const MARKER_CLEANUP_NOTICE = "原审核页面标记清理失败，请刷新页面";
const AFFILIATION_INTENT_MISMATCH_ERROR =
  "挂靠填写意图字段异常，已停止自动填写，请人工核对挂靠信息";

/** 合法填写意图必须恰好覆盖的两个挂靠字段；其他形态一律转为阻塞项。 */
const AFFILIATION_FILL_FIELDS: readonly PageFillAction["field"][] = Object.freeze([
  "old_vehicle.affiliation",
  "new_vehicle.affiliation",
] as const);

/** 意图必须不多不少、不重复地覆盖两个挂靠字段（顺序无关）。 */
function coversExactlyAffiliationFields(
  intent: readonly PageFillAction[],
): boolean {
  if (intent.length !== AFFILIATION_FILL_FIELDS.length) return false;
  const fields = new Set(intent.map((action) => action?.field));
  return (
    fields.size === AFFILIATION_FILL_FIELDS.length
    && AFFILIATION_FILL_FIELDS.every((field) => fields.has(field))
  );
}

/**
 * chrome.tabs.sendMessage 在标签页导航/关闭、Content Script 上下文失效时
 * 直接 reject（而不是返回 {ok:false}）；提取可读文案，缺失时回退到统一失效提示。
 */
function rejectionMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return undefined;
}

/**
 * 挂靠写入的一次性闸门，按采集 ID 键控；由 hook 层持有，
 * stepsKey 变化导致的会话重建绝不重置，同一采集只允许发起一次写入。
 */
export interface AffiliationFillLatch {
  isEngaged(collectionId: string): boolean;
  engage(collectionId: string): void;
}

export function createAffiliationFillLatch(): AffiliationFillLatch {
  const engaged = new Set<string>();
  return {
    isEngaged: (collectionId) => engaged.has(collectionId),
    engage: (collectionId) => {
      engaged.add(collectionId);
    },
  };
}

export interface ScrapSessionGateways {
  show(step: ReviewStep, pageData: PageData): Promise<PageReviewResult>;
  complete(stepId: string, pageData: PageData): Promise<PageReviewResult>;
  clear(pageData: PageData): Promise<PageReviewResult>;
  subscribe(
    context: PageReviewDecisionContext,
    onDecision: (event: PageReviewDecisionEvent) => void,
  ): () => void;
}

/** 生产环境默认走真实页面客户端；测试可整体替换。 */
const pageClientGateways: ScrapSessionGateways = {
  show: (step, pageData) => showPageReviewStep(step, pageData),
  complete: (stepId, pageData) => completePageReviewStep(stepId, pageData),
  clear: (pageData) => clearPageReviewMarkers(pageData),
  subscribe: (context, onDecision) =>
    subscribePageReviewDecisions(context, onDecision),
};

export interface ScrapSessionSnapshot {
  readonly sessionKey: string;
  readonly session: ReviewSessionState;
  /** 唯一需要人工处理的页面外事项；其余任何步骤都不暴露给助手。 */
  readonly assistantStep: ReviewStep | null;
  readonly blockingIssue: string | null;
}

export interface ScrapSessionOptions {
  steps: readonly ReviewStep[];
  pageData: PageData;
  sessionKey?: string;
  getPageFillIntent(): PageFillAction[];
  applyAffiliationFill(actions: PageFillAction[]): Promise<PageFillResult>;
  onChange(snapshot: ScrapSessionSnapshot): void;
  gateways?: Partial<ScrapSessionGateways>;
  /** 跨会话重建的一次性写入闸门；缺省时退化为会话内闸门。 */
  affiliationFillLatch?: AffiliationFillLatch;
}

export interface ScrapReplacementSession {
  start(): void;
  decide(stepId: string, decision: ReviewerDecision): void;
  /** 取消订阅并清理页面标记；返回清理结果供调用方提示刷新。 */
  dispose(): Promise<PageReviewResult | null>;
}

/**
 * 一次字段优先审核会话的编排器（spec §11/§12）。
 * 与 React 解耦：hook 只负责生命周期，测试可直接驱动。
 */
export function createScrapReplacementSession(
  options: ScrapSessionOptions,
): ScrapReplacementSession {
  const { steps, pageData, onChange } = options;
  const gateways: ScrapSessionGateways = {
    ...pageClientGateways,
    ...options.gateways,
  };
  const sessionKey = options.sessionKey ?? "";
  // 一次会话内挂靠写入只允许发起一次；hook 传入跨重建的闸门时以其为准。
  const fillLatch = options.affiliationFillLatch ?? createAffiliationFillLatch();

  let state = createReviewSession(steps);
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let pumping = false;
  let queued = false;
  let freezing = false;

  function snapshot(): ScrapSessionSnapshot {
    const step = currentStep(state);
    return {
      sessionKey,
      session: state,
      assistantStep:
        state.phase === "WAITING_REVIEWER" && step?.display_target === "ASSISTANT"
          ? step
          : null,
      blockingIssue:
        state.phase === "STALE_PAGE" ? state.blockingIssue ?? null : null,
    };
  }

  function emit() {
    if (!disposed) onChange(snapshot());
  }

  function failWith(message: string | undefined) {
    state = failReviewSession(state, message || FALLBACK_SESSION_ERROR);
    emit();
  }

  function commit(next: ReviewSessionState): boolean {
    if (next === state) return false;
    state = next;
    emit();
    return true;
  }

  /** spec §12：主体关系 MATCH 时，先确认三个保护步骤也 MATCH 且填写意图恰好覆盖两个挂靠字段，再执行唯一一次写入。 */
  async function runAffiliationGate(step: ReviewStep): Promise<boolean> {
    const next = completeMatchedStep(state, step.step_id);
    if (next === state) return false;
    const intent = options.getPageFillIntent();
    // 防御后端不一致载荷：保护步骤必须既是 MATCH 又不要求人工处理。
    const protectionsMatched = AFFILIATION_PROTECTION_STEP_IDS.every((stepId) =>
      state.steps.some(
        (item) =>
          item.step_id === stepId
          && item.result_status === "MATCH"
          && !stepRequiresReviewerAction(item),
      ),
    );
    if (
      !protectionsMatched
      || intent.length === 0
      || fillLatch.isEngaged(pageData.collectionId)
    ) {
      // 守护未全部通过、后端没有填写意图或本采集已发起过：绝不写入，静默前进。
      commit(next);
      return true;
    }
    if (!coversExactlyAffiliationFields(intent)) {
      // 意图形态非法（缺字段、多字段、重复或陌生字段）：绝不写入，转为阻塞项。
      failWith(AFFILIATION_INTENT_MISMATCH_ERROR);
      return false;
    }
    // 闸门在发起前落下：写入中途 dispose/重建同样计为唯一一次，绝不重试。
    fillLatch.engage(pageData.collectionId);
    let result: PageFillResult;
    try {
      result = await options.applyAffiliationFill(intent);
    } catch (error) {
      // 传输层拒绝（标签页导航/关闭、上下文失效）按身份失效处理，不得成为未处理拒绝。
      failWith(rejectionMessage(error));
      return false;
    }
    if (disposed) return false;
    if (result.ok) {
      // 成功：直接继续，不添加任何常驻结果卡片。
      commit(next);
      return true;
    }
    // 失败：设置阻塞项并等待人工处理（早期返回没有 actions 字段，只依赖 message）。
    failWith(result.message);
    return false;
  }

  async function runUntilWait(): Promise<void> {
    while (!disposed) {
      if (state.phase === "COMPLETED" || state.phase === "STALE_PAGE") return;
      const step = currentStep(state);
      if (!step) return;
      if (step.display_target === "PAGE_FIELD") {
        let shown: PageReviewResult;
        try {
          shown = await gateways.show(step, pageData);
        } catch (error) {
          // 消息发送被拒绝（标签页导航/关闭、上下文失效）按身份失效处理。
          failWith(rejectionMessage(error));
          return;
        }
        if (disposed) return;
        if (!shown.ok) {
          // 身份/DOM 目标拒绝：停止后续全部标记和写入。
          failWith(shown.error);
          return;
        }
        if (!stepRequiresReviewerAction(step)) {
          // 标记自身常驻展示核验成功，不发 COMPLETE，直接自动前进。
          if (!commit(completeMatchedStep(state, step.step_id))) return;
          continue;
        }
        // 页面异常项：等待 Content Script 的 REVIEW_FIELD_DECISION 事件。
        return;
      }
      if (
        step.step_id === AFFILIATION_SUBJECT_STEP_ID
        && !stepRequiresReviewerAction(step)
      ) {
        if (!(await runAffiliationGate(step))) return;
        continue;
      }
      if (!stepRequiresReviewerAction(step)) {
        // 助手成功项：不渲染，直接隐藏并前进。
        if (!commit(completeMatchedStep(state, step.step_id))) return;
        continue;
      }
      // 唯一当前助手事项：等待组件按钮，一次点击即记录并前进。
      return;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) {
      queued = true;
      return;
    }
    pumping = true;
    try {
      do {
        queued = false;
        await runUntilWait();
      } while (queued && !disposed);
    } catch (error) {
      // 兜底：任何漏网异常都必须转为阻塞项，绝不让 void pump() 变成未处理拒绝。
      failWith(rejectionMessage(error));
    } finally {
      pumping = false;
    }
  }

  async function freezeMarkerThenCommit(
    stepId: string,
    next: ReviewSessionState,
  ): Promise<void> {
    freezing = true;
    try {
      let completed: PageReviewResult;
      try {
        completed = await gateways.complete(stepId, pageData);
      } catch (error) {
        // COMPLETE 消息被拒绝：按身份失效处理，绝不静默吞掉。
        completed = { ok: false, error: rejectionMessage(error) };
      }
      if (!disposed) {
        // 人工选择已记录；再冻结页面标记，冻结被拒绝按身份失效处理。
        state = completed.ok
          ? next
          : failReviewSession(next, completed.error || FALLBACK_SESSION_ERROR);
        emit();
      }
    } finally {
      freezing = false;
    }
    await pump();
  }

  function onDecisionEvent(event: PageReviewDecisionEvent) {
    if (disposed || freezing) return;
    const step = currentStep(state);
    if (!step || step.step_id !== event.stepId) return;
    if (step.display_target !== "PAGE_FIELD") return;
    const next = recordReviewerDecision(state, event.stepId, event.decision);
    if (next === state) return;
    void freezeMarkerThenCommit(step.step_id, next);
  }

  return {
    start() {
      if (disposed || unsubscribe) return;
      unsubscribe = gateways.subscribe(
        {
          pageInstanceId: pageData.pageInstanceId,
          collectionId: pageData.collectionId,
          getCurrentStepId: () => currentStep(state)?.step_id ?? null,
        },
        onDecisionEvent,
      );
      emit();
      void pump();
    },
    decide(stepId: string, decision: ReviewerDecision) {
      if (disposed || freezing) return;
      const step = currentStep(state);
      if (!step || step.step_id !== stepId) return;
      if (step.display_target !== "ASSISTANT") return;
      // 点击“确认无误”或“标记异常”后立即记录并进入下一项，不再额外点击“继续”。
      if (commit(recordReviewerDecision(state, stepId, decision))) void pump();
    },
    async dispose() {
      if (disposed) return null;
      disposed = true;
      const stopListening = unsubscribe;
      unsubscribe = null;
      try {
        stopListening?.();
        return await gateways.clear(pageData);
      } catch (error) {
        // 取消订阅或清理标记被拒绝：转为清理失败结果，交由调用方提示刷新页面，
        // 绝不让 dispose() 变成未处理拒绝。
        return { ok: false, error: rejectionMessage(error) };
      }
    },
  };
}

export interface ScrapReplacementReviewController {
  readonly active: boolean;
  readonly assistantStep: ReviewStep | null;
  readonly blockingIssue: string | null;
  /** 标记清理失败等需要提示刷新页面的通知。 */
  readonly notice: string;
  decide(stepId: string, decision: ReviewerDecision): void;
}

/**
 * 在 App 层持有字段优先会话：reset、开始新审核、业务切换和卸载都会
 * 触发 effect 清理（取消订阅 + 清理页面标记），旧会话绝不继续。
 */
export function useScrapReplacementReview(
  workflow: ReviewWorkflow,
): ScrapReplacementReviewController {
  const { review, pageData, applyAffiliationFill } = workflow;
  const active = Boolean(review && pageData && isFieldFirstProfile(review));
  const [snapshot, setSnapshot] = useState<ScrapSessionSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  const sessionRef = useRef<ScrapReplacementSession | null>(null);
  const reviewRef = useRef<ReviewResponse | null>(review);
  // 一次性写入闸门按采集 ID 键控并跨 effect 重建存活（useState 初始化器只执行一次）。
  const [fillLatch] = useState(createAffiliationFillLatch);
  // 每次 effect 运行领取一个代号；只有最新一代允许写入清理通知。
  const generationRef = useRef(0);

  useEffect(() => {
    reviewRef.current = review;
  });

  // 会话只随步骤内容重建；轮询产生的新对象身份不打断进行中的标记流程。
  const stepsKey = useMemo(
    () =>
      (review?.review_steps ?? [])
        .map(
          (step) =>
            `${step.step_id}:${step.sequence}:${step.result_status}:${step.requires_reviewer_action}:${step.display_target}`,
        )
        .join("|"),
    [review],
  );

  useEffect(() => {
    if (!active || !pageData) return;
    const currentReview = reviewRef.current;
    if (!currentReview) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    const session = createScrapReplacementSession({
      steps: currentReview.review_steps ?? [],
      pageData,
      sessionKey: stepsKey,
      getPageFillIntent: () => reviewRef.current?.page_fill_intent ?? [],
      applyAffiliationFill,
      affiliationFillLatch: fillLatch,
      // 会话快照只经由 start/decide/dispose 异步驱动，避免 effect 体内同步 setState。
      onChange: (next) => {
        setSnapshot(next);
        setNotice("");
      },
    });
    sessionRef.current = session;
    session.start();
    return () => {
      sessionRef.current = null;
      // 清理失败（身份拒绝或消息被拒）只提示刷新页面；旧会话已停止，不再继续。
      // 代号守卫：已销毁旧会话的异步通知绝不覆盖已重建新会话的通知状态。
      const notifyCleanupFailure = () => {
        if (generationRef.current === generation) setNotice(MARKER_CLEANUP_NOTICE);
      };
      void session.dispose().then((cleared) => {
        if (cleared && !cleared.ok) notifyCleanupFailure();
      }, notifyCleanupFailure);
    };
  }, [active, stepsKey, pageData, applyAffiliationFill, fillLatch]);

  const decide = useCallback((stepId: string, decision: ReviewerDecision) => {
    sessionRef.current?.decide(stepId, decision);
  }, []);

  // 展示层守卫：只有属于当前步骤内容且仍激活的会话快照才可见；
  // reset、业务切换或新审核后旧快照立即不可见，无需在 effect 体内清空。
  const visible =
    active && snapshot && snapshot.sessionKey === stepsKey ? snapshot : null;

  return {
    active,
    assistantStep: visible?.assistantStep ?? null,
    blockingIssue: visible?.blockingIssue ?? null,
    notice,
    decide,
  };
}
