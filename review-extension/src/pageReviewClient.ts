/**
 * 页面审核消息客户端（spec §10）。
 * 只负责构造带完整身份参数的消息和过滤入站人工事件；
 * 不持有会话状态，不吞掉 Content Script 的拒绝响应，由调用方（Task 6 编排 hook）处理。
 */
import type { PageData, ReviewTask } from "./types/review";
import type { ReviewerDecision } from "./reviewSession.ts";
import { REVIEWER_DECISIONS } from "./reviewSession.ts";

export interface PageReviewResult {
  ok: boolean;
  error?: string;
}

/** Content Script 发来的、已通过身份过滤的人工选择事件。 */
export interface PageReviewDecisionEvent {
  stepId: string;
  decision: ReviewerDecision;
  pageInstanceId: string;
  collectionId: string;
}

/** 当前会话身份；getCurrentStepId 跟随会话推进，过期步骤的事件必须被忽略。 */
export interface PageReviewDecisionContext {
  pageInstanceId: string;
  collectionId: string;
  getCurrentStepId(): string | null;
}

interface ChromeTabsLike {
  tabs: {
    sendMessage?(tabId: number, message: unknown): Promise<PageReviewResult>;
  };
}

type RuntimeMessageListener = (message: unknown) => void;

interface ChromeRuntimeLike {
  runtime: {
    onMessage: {
      addListener(listener: RuntimeMessageListener): void;
      removeListener(listener: RuntimeMessageListener): void;
    };
  };
}

const IDENTITY_ERROR = "原审核页面标识不完整，请重新审核";
const STEP_ID_ERROR = "审核步骤缺少标识";
const NO_RESPONSE_ERROR = "页面审核标记无响应，请重新审核";

function reviewIdentity(pageData: PageData) {
  if (
    !pageData
    || !Number.isInteger(pageData.sourceTabId)
    || !pageData.pageUrl
    || !pageData.pageInstanceId
    || !pageData.pageFingerprint
    || !pageData.collectionId
  ) {
    return null;
  }
  return {
    expectedPageUrl: pageData.pageUrl,
    expectedPageInstanceId: pageData.pageInstanceId,
    expectedPageFingerprint: pageData.pageFingerprint,
    expectedCollectionId: pageData.collectionId,
  };
}

async function sendReviewMessage(
  chromeApi: ChromeTabsLike,
  pageData: PageData,
  message: Record<string, unknown>,
): Promise<PageReviewResult> {
  const identity = reviewIdentity(pageData);
  if (!identity || !chromeApi?.tabs?.sendMessage) return { ok: false, error: IDENTITY_ERROR };
  // Content Script 的身份/目标拒绝响应原样返回给调用方，不做拦截或重试。
  const response = await chromeApi.tabs.sendMessage(pageData.sourceTabId, { ...message, ...identity });
  return response ?? { ok: false, error: NO_RESPONSE_ERROR };
}

export async function showPageReviewTask(
  step: ReviewTask,
  pageData: PageData,
  chromeApi: ChromeTabsLike = globalThis.chrome,
): Promise<PageReviewResult> {
  if (!step?.step_id) return { ok: false, error: STEP_ID_ERROR };
  return sendReviewMessage(chromeApi, pageData, { type: "SHOW_REVIEW_FIELD_STEP", step });
}

export async function completePageReviewTask(
  stepId: string,
  pageData: PageData,
  chromeApi: ChromeTabsLike = globalThis.chrome,
): Promise<PageReviewResult> {
  if (!stepId) return { ok: false, error: STEP_ID_ERROR };
  return sendReviewMessage(chromeApi, pageData, { type: "COMPLETE_REVIEW_FIELD_STEP", stepId });
}

export async function clearPageReviewMarkers(
  pageData: PageData,
  chromeApi: ChromeTabsLike = globalThis.chrome,
): Promise<PageReviewResult> {
  return sendReviewMessage(chromeApi, pageData, { type: "CLEAR_REVIEW_FIELD_MARKERS" });
}

function parseDecisionEvent(message: unknown): PageReviewDecisionEvent | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== "REVIEW_FIELD_DECISION") return null;
  if (
    typeof candidate.stepId !== "string"
    || typeof candidate.pageInstanceId !== "string"
    || typeof candidate.collectionId !== "string"
    || !REVIEWER_DECISIONS.includes(candidate.decision as ReviewerDecision)
  ) {
    return null;
  }
  return {
    stepId: candidate.stepId,
    decision: candidate.decision as ReviewerDecision,
    pageInstanceId: candidate.pageInstanceId,
    collectionId: candidate.collectionId,
  };
}

/**
 * 订阅当前会话的人工选择事件；pageInstanceId、collectionId 或 stepId
 * 与会话不一致的过期事件一律忽略。返回取消订阅函数，React effect 卸载、
 * 重新审核和业务切换时必须调用。
 */
export function subscribePageReviewDecisions(
  context: PageReviewDecisionContext,
  onDecision: (event: PageReviewDecisionEvent) => void,
  chromeApi: ChromeRuntimeLike = globalThis.chrome,
): () => void {
  const listener: RuntimeMessageListener = (message) => {
    const event = parseDecisionEvent(message);
    if (!event) return;
    if (event.pageInstanceId !== context.pageInstanceId) return;
    if (event.collectionId !== context.collectionId) return;
    if (event.stepId !== context.getCurrentStepId()) return;
    onDecision(event);
  };
  chromeApi.runtime.onMessage.addListener(listener);
  return () => chromeApi.runtime.onMessage.removeListener(listener);
}
