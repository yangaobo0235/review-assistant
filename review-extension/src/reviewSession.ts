/**
 * 逐字段审核会话状态机（spec §11）。
 * 纯内存、纯函数：不访问 chrome/DOM，不落库，不跨刷新保存；
 * 人工选择只记录在 decisions 中，绝不改写后端步骤的 result_status。
 * 每次转换都校验当前 stepId 并返回冻结的新状态；不合法的旧按钮或重复事件原样返回旧状态。
 */
import type { ReviewStep } from "./types/review";
import { sortedReviewSteps, stepRequiresReviewerAction } from "./reviewSteps.ts";

export type ReviewSessionPhase =
  | "RUNNING" | "WAITING_REVIEWER" | "STALE_PAGE" | "COMPLETED";
export type ReviewerDecision = "CONFIRMED" | "MARKED_EXCEPTION";

/** 人工选择只有两种；其他值一律拒绝。 */
export const REVIEWER_DECISIONS: readonly ReviewerDecision[] = Object.freeze([
  "CONFIRMED",
  "MARKED_EXCEPTION",
]);

export interface ReviewSessionState {
  readonly phase: ReviewSessionPhase;
  readonly index: number;
  readonly steps: readonly ReviewStep[];
  readonly decisions: Readonly<Record<string, ReviewerDecision>>;
  readonly completedStepIds: readonly string[];
  readonly blockingIssue?: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function phaseAt(steps: readonly ReviewStep[], index: number): ReviewSessionPhase {
  if (index >= steps.length) return "COMPLETED";
  return stepRequiresReviewerAction(steps[index]) ? "WAITING_REVIEWER" : "RUNNING";
}

function derivePhase(state: ReviewSessionState): ReviewSessionState {
  return deepFreeze({ ...state, phase: phaseAt(state.steps, state.index) });
}

export function createReviewSession(steps: readonly ReviewStep[]): ReviewSessionState {
  // 复制后端步骤，会话内部与外部载荷完全隔离；按 sequence 排序后冻结。
  return derivePhase({
    phase: "RUNNING",
    index: 0,
    steps: sortedReviewSteps(steps.map((step) => structuredClone(step))),
    decisions: {},
    completedStepIds: [],
  });
}

export function currentStep(state: ReviewSessionState): ReviewStep | null {
  return state.steps[state.index] ?? null;
}

function advance(state: ReviewSessionState, decisions: ReviewSessionState["decisions"]): ReviewSessionState {
  const completed = currentStep(state);
  return derivePhase({
    ...state,
    index: state.index + 1,
    decisions,
    completedStepIds: completed ? [...state.completedStepIds, completed.step_id] : state.completedStepIds,
  });
}

/** MATCH 步骤核验完成（页面标记成功或助手项直接通过）后自动前进。 */
export function completeMatchedStep(state: ReviewSessionState, stepId: string): ReviewSessionState {
  if (state.phase !== "RUNNING") return state;
  const step = currentStep(state);
  if (!step || step.step_id !== stepId) return state;
  if (stepRequiresReviewerAction(step)) return state;
  return advance(state, state.decisions);
}

/** 记录审核员选择并立即前进；选择只保存在前端内存，不篡改后端结论。 */
export function recordReviewerDecision(
  state: ReviewSessionState,
  stepId: string,
  decision: ReviewerDecision,
): ReviewSessionState {
  if (state.phase !== "WAITING_REVIEWER") return state;
  const step = currentStep(state);
  if (!step || step.step_id !== stepId) return state;
  if (!REVIEWER_DECISIONS.includes(decision)) return state;
  return advance(state, { ...state.decisions, [stepId]: decision });
}

/** 页面实例、URL、指纹、采集 ID 或 DOM 目标失效时立即停止后续标记和写入。 */
export function failReviewSession(state: ReviewSessionState, blockingIssue: string): ReviewSessionState {
  // 保留第一个失效原因；已完成或已失效的会话不再变化。
  if (state.phase === "STALE_PAGE" || state.phase === "COMPLETED") return state;
  return deepFreeze({ ...state, phase: "STALE_PAGE", blockingIssue });
}
