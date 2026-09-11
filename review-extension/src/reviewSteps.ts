import type { ReviewStep } from "./types/review";
import { fieldLabel } from "./reviewPanelConfig.ts";

export type ReviewStepDecision = "ACKNOWLEDGED" | "MANUAL_REVIEW";

export interface ReviewStepState {
  index: number;
  decisions: Record<string, ReviewStepDecision>;
}

export function sortedReviewSteps(steps: readonly ReviewStep[] = []): ReviewStep[] {
  return [...steps].sort((left, right) => left.sequence - right.sequence);
}

/** 后端契约守卫：只有 MATCH 且无需人工处理的步骤允许自动前进（spec §11 规则 1-4）。 */
export function stepRequiresReviewerAction(step: ReviewStep): boolean {
  return step.requires_reviewer_action === true || step.result_status !== "MATCH";
}

export function createReviewStepState(steps: readonly ReviewStep[]): ReviewStepState {
  return { index: Math.min(0, steps.length), decisions: {} };
}

export function nextReviewStep(state: ReviewStepState, total?: number): ReviewStepState {
  const limit = total == null ? state.index + 1 : total;
  return { ...state, index: Math.min(state.index + 1, limit) };
}

export function previousReviewStep(state: ReviewStepState): ReviewStepState {
  return { ...state, index: Math.max(0, state.index - 1) };
}

export function acknowledgeStep(
  state: ReviewStepState,
  stepId: string,
  decision: ReviewStepDecision,
): ReviewStepState {
  return { ...state, decisions: { ...state.decisions, [stepId]: decision } };
}

export function reviewStepStatusLabel(status: ReviewStep["result_status"]): string {
  return { MATCH: "已核验", CONFLICT: "存在冲突", INSUFFICIENT: "证据不足" }[status];
}

export function reviewStepTitle(step: ReviewStep): string {
  return step.category === "FIELD" ? fieldLabel(step.label) : step.label;
}

/** 只按后端结构化 step_id 识别主体关系结论；spec §5.1 禁止按中文 label 推断。 */
export function isAffiliationRelationshipStep(step: ReviewStep): boolean {
  return step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001"
    || step.step_id === "AFFILIATION-SUBJECT-001";
}

export function reviewStepDecisionLabel(decision?: ReviewStepDecision): string | null {
  if (decision === "ACKNOWLEDGED") return "已知悉，继续";
  if (decision === "MANUAL_REVIEW") return "已标记人工复核";
  return null;
}
