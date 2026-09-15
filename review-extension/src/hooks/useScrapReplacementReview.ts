/**
 * 功能：目标业务（青岛/长春报废置换 1.0）的字段优先审核编排。
 * 职责边界：只驱动 reviewSession 状态机和页面审核客户端，不渲染界面；
 * 人工选择只记录在前端内存，绝不篡改后端 MATCH/CONFLICT/INSUFFICIENT 结论；
 * 挂靠写入只在主体关系 MATCH、后端返回两个明确主体类型且存在填写意图时执行一次；
 * clearPageReviewMarkers / subscribePageReviewDecisions 保留为旧宿主协议兼容名称，但新流程不调用页面标记。
 * 页面实例、URL、指纹、采集 ID 或 DOM 目标失效时立即停止后续标记和写入。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PageFillResult } from "../pageFillClient";
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
import { REVIEW_TASK_IDS, stepRequiresReviewerAction } from "../reviewSteps.ts";
import type {
  PageData,
  PageFillAction,
  ReviewResponse,
  ReviewTask,
} from "../types/review";
import type { ReviewWorkflow } from "./useReviewWorkflow";

/**
 * 主体关系步骤的稳定后端 step_id（app/rules/affiliation_subject_checks.py 的
 * AFFILIATION-SUBJECT-001 经 review_step_routing 加 BUSINESS- 前缀）。
 * 只按 step_id 识别，绝不按中文 label 文本匹配。
 */
export const AFFILIATION_SUBJECT_STEP_ID = REVIEW_TASK_IDS.affiliationSubject;

/** 历史辅助步骤 ID，保留导出兼容；挂靠动作的安全闸门由后端主体关系结果和页面写回校验负责。 */
export const AFFILIATION_PROTECTION_STEP_IDS: readonly string[] = Object.freeze([
  REVIEW_TASK_IDS.affiliationOwnerType,
  REVIEW_TASK_IDS.affiliationNewVin,
  REVIEW_TASK_IDS.affiliationCustomerName,
]);

const FALLBACK_SESSION_ERROR = "页面审核标记已失效，请重新审核";
const MARKER_CLEANUP_NOTICE = "原审核页面标记清理失败，请刷新页面";
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
  show(step: ReviewTask, pageData: PageData): Promise<PageReviewResult>;
  complete(stepId: string, pageData: PageData): Promise<PageReviewResult>;
  clear(pageData: PageData): Promise<PageReviewResult>;
  subscribe(
    context: PageReviewDecisionContext,
    onDecision: (event: PageReviewDecisionEvent) => void,
  ): () => void;
}

/** 生产环境默认走真实页面客户端；测试可整体替换。 */
const pageClientGateways: ScrapSessionGateways = {
  // 报废置换新流程全部在侧边栏展示；原页面不再注入标记或订阅人工事件。
  show: async () => ({ ok: true }),
  complete: async () => ({ ok: true }),
  clear: async () => ({ ok: true }),
  subscribe: () => () => undefined,
};

export interface ScrapSessionSnapshot {
  readonly sessionKey: string;
  readonly session: ReviewSessionState;
  /** 唯一需要人工处理的页面外事项；其余任何步骤都不暴露给助手。 */
  readonly assistantStep: ReviewTask | null;
  readonly blockingIssue: string | null;
}

export interface ScrapSessionOptions {
  steps: readonly ReviewTask[];
  pageData: PageData;
  sessionKey?: string;
  getPageFillIntent(): PageFillAction[];
  applyAffiliationFill(actions: PageFillAction[]): Promise<PageFillResult>;
  onChange(snapshot: ScrapSessionSnapshot): void;
  gateways?: Partial<ScrapSessionGateways>;
  /** 跨会话重建的一次性写入闸门；缺省时退化为会话内闸门。 */
  affiliationFillLatch?: AffiliationFillLatch;
  /** Legacy test/embedding opt-in; production field-first flow keeps this false. */
  autoFillAffiliation?: boolean;
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
  let state = createReviewSession(steps);
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let pumping = false;
  let queued = false;
  let freezing = false;
  const fillLatch = options.affiliationFillLatch ?? createAffiliationFillLatch();

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

  /** 主体关系通过后只前进；挂靠写入必须由审核员在工作台主动触发。 */
  async function runAffiliationGate(step: ReviewTask): Promise<boolean> {
    const next = completeMatchedStep(state, step.step_id);
    if (next === state) return false;
    if (options.autoFillAffiliation === false) {
      commit(next);
      return true;
    }
    const intent = options.getPageFillIntent();
    if (intent.length === 0 || fillLatch.isEngaged(pageData.collectionId)) { commit(next); return true; }
    if (intent.length !== 2 || new Set(intent.map((action) => action.field)).size !== 2 || !intent.some((action) => action.field === "old_vehicle.affiliation") || !intent.some((action) => action.field === "new_vehicle.affiliation")) { failWith("挂靠填写意图字段异常，已停止自动填写，请人工核对挂靠信息"); return false; }
    fillLatch.engage(pageData.collectionId);
    let result: PageFillResult;
    try { result = await options.applyAffiliationFill(intent); } catch (error) { failWith(rejectionMessage(error)); return false; }
    if (disposed) return false;
    if (result.ok) { commit(next); return true; }
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
  readonly assistantStep: ReviewTask | null;
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
  const active = Boolean(
    review
    && pageData
    && review.presentation === "FIELD_WORKBENCH"
    && review.review_tasks?.length,
  );
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
      (review?.review_tasks ?? [])
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
      steps: currentReview.review_tasks ?? [],
      pageData,
      sessionKey: stepsKey,
      getPageFillIntent: () => reviewRef.current?.page_fill_intent ?? [],
      applyAffiliationFill,
      // 主体关系通过且后端给出合法意图后，自动把规则推导的个人/公司
      // 写入两个挂靠下拉框；辅助核验仍在工作台独立展示。
      autoFillAffiliation: true,
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
