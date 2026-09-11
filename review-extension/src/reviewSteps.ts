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

export function isAffiliationRelationshipStep(step: ReviewStep): boolean {
  return step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001"
    || step.step_id === "AFFILIATION-SUBJECT-001"
    || step.label === "新旧车挂靠主体关系";
}

export function reviewStepDecisionLabel(decision?: ReviewStepDecision): string | null {
  if (decision === "ACKNOWLEDGED") return "已知悉，继续";
  if (decision === "MANUAL_REVIEW") return "已标记人工复核";
  return null;
}
