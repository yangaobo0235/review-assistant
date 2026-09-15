/**
 * 报废置换字段优先编排的共享测试脚手架。
 * 由 scrap-replacement-review.test.mjs 与 scrap-replacement-review-wiring.test.mjs 共用，
 * 保证两份测试对 pageData、步骤工厂、微任务沉降、决策事件与网关桩使用同一套语义。
 */
import { createScrapReplacementSession } from "../../src/hooks/useScrapReplacementReview.ts";

export const pageData = {
  pageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1",
  sourceTabId: 42,
  pageInstanceId: "page-instance",
  pageFingerprint: '[["application.id","case-a"]]',
  collectionId: "collection-1",
};

export const makeStep = (overrides) => ({
  sequence: 1,
  category: "BUSINESS_RULE",
  display_target: "ASSISTANT",
  requires_reviewer_action: false,
  label: "审核步骤",
  result_status: "MATCH",
  reason: "",
  values: [],
  evidence: [],
  ...overrides,
  page_field: overrides.page_field ?? (String(overrides.step_id || "").startsWith("FIELD-") ? String(overrides.step_id).slice(6) : null),
});

/** 沉降编排器的微任务链；两次 setImmediate 足以跑完自动前进。 */
export const settle = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

/** 模拟 Content Script 发来的、已通过身份过滤的人工选择事件。 */
export const decisionEvent = (stepId, decision = "CONFIRMED", overrides = {}) => ({
  stepId,
  decision,
  pageInstanceId: pageData.pageInstanceId,
  collectionId: pageData.collectionId,
  ...overrides,
});

/**
 * 页面客户端网关桩：记录调用、管理订阅者；overrides 里返回 `{ok:false}`
 * 模拟身份拒绝，直接 throw 模拟 sendMessage 的传输层拒绝。
 */
export function makeGateways(overrides = {}) {
  const calls = { show: [], complete: [], clear: [], fill: [] };
  const listeners = new Set();
  return {
    calls,
    listenerCount: () => listeners.size,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    api: {
      show: async (step) => {
        calls.show.push(step.step_id);
        return overrides.show?.(step) ?? { ok: true };
      },
      complete: async (stepId) => {
        calls.complete.push(stepId);
        return overrides.complete?.(stepId) ?? { ok: true };
      },
      clear: async () => {
        calls.clear.push(true);
        return overrides.clear?.() ?? { ok: true };
      },
      subscribe: (_context, onDecision) => {
        listeners.add(onDecision);
        return () => listeners.delete(onDecision);
      },
      applyFill: async (actions) => {
        calls.fill.push(actions);
        return overrides.applyFill?.(actions) ?? { ok: true, message: "挂靠字段已填写并回读" };
      },
    },
  };
}

/**
 * 用网关桩驱动一次真实编排会话。
 * options：gateways（网关覆盖）、pageFillIntent、applyAffiliationFill（自定义写入实现，
 * 可 throw）、fillResult（自定义写入结果）、affiliationFillLatch（跨会话共享闸门）、
 * pageData / sessionKey（覆盖默认身份）。
 */
export function runSession(steps, options = {}) {
  const gateways = makeGateways(options.gateways);
  const snapshots = [];
  const fills = [];
  const session = createScrapReplacementSession({
    steps,
    pageData: options.pageData ?? pageData,
    sessionKey: options.sessionKey ?? "test-session",
    getPageFillIntent: () => options.pageFillIntent ?? [],
    applyAffiliationFill: async (actions) => {
      fills.push(actions);
      if (options.applyAffiliationFill) return options.applyAffiliationFill(actions);
      return options.fillResult ?? { ok: true, message: "挂靠字段已填写并回读" };
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    gateways: gateways.api,
    affiliationFillLatch: options.affiliationFillLatch,
  });
  return {
    session,
    gateways,
    snapshots,
    fills,
    latest: () => snapshots.at(-1) ?? null,
    currentStepId: () => {
      const state = snapshots.at(-1)?.session;
      return state ? state.steps[state.index]?.step_id ?? null : null;
    },
  };
}
