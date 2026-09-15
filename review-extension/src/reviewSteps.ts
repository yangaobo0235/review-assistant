import type { ReviewTask } from "./types/review";
import { fieldLabel } from "./reviewPanelConfig.ts";

export type ReviewTaskDecision = "ACKNOWLEDGED" | "MANUAL_REVIEW";

/** Stable task identifiers owned by the v2 backend protocol. */
export const REVIEW_TASK_IDS = Object.freeze({
  affiliationSubject: "BUSINESS-AFFILIATION-SUBJECT-001",
  affiliationOwnerType: "BUSINESS-AFFILIATION-AUX-OWNER-TYPE",
  affiliationNewVin: "BUSINESS-AFFILIATION-AUX-NEW-VIN",
  affiliationCustomerName: "BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME",
  qrGroup: "QR-GROUP",
  materialGroup: "MATERIAL-GROUP",
} as const);

export interface ReviewTaskState {
  index: number;
  decisions: Record<string, ReviewTaskDecision>;
}

export function sortedReviewTasks(steps: readonly ReviewTask[] = []): ReviewTask[] {
  return [...steps].sort((left, right) => left.sequence - right.sequence);
}

/** 后端契约守卫：只有 MATCH 且无需人工处理的步骤允许自动前进（spec §11 规则 1-4）。 */
export function stepRequiresReviewerAction(step: ReviewTask): boolean {
  // 后端可以明确声明 NOT_FOUND/INSUFFICIENT 为非阻塞提示；只有未声明时
  // 才回退到旧的“非 MATCH 需要处理”兼容语义。
  return step.requires_reviewer_action === true
    || (step.requires_reviewer_action !== false && step.result_status !== "MATCH");
}

export function createReviewTaskState(_steps: readonly ReviewTask[]): ReviewTaskState {
  void _steps;
  return { index: 0, decisions: {} };
}

export function nextReviewTask(state: ReviewTaskState, total?: number): ReviewTaskState {
  const limit = total == null ? state.index + 1 : total;
  return { ...state, index: Math.min(state.index + 1, limit) };
}

export function previousReviewTask(state: ReviewTaskState): ReviewTaskState {
  return { ...state, index: Math.max(0, state.index - 1) };
}

export function acknowledgeStep(
  state: ReviewTaskState,
  stepId: string,
  decision: ReviewTaskDecision,
): ReviewTaskState {
  return { ...state, decisions: { ...state.decisions, [stepId]: decision } };
}

export function reviewStepStatusLabel(status: ReviewTask["result_status"]): string {
  return { MATCH: "已核验", CONFLICT: "存在冲突", INSUFFICIENT: "证据不足" }[status];
}

export function reviewStepTitle(step: ReviewTask): string {
  return step.category === "FIELD" ? fieldLabel(step.label) : step.label;
}

/** 只按后端结构化 step_id 识别主体关系结论；spec §5.1 禁止按中文 label 推断。 */
export function isAffiliationRelationshipStep(step: ReviewTask): boolean {
  return step.step_id === REVIEW_TASK_IDS.affiliationSubject
    || step.step_id === "AFFILIATION-SUBJECT-001";
}

export function isQrTask(step: ReviewTask): boolean {
  return step.step_id === REVIEW_TASK_IDS.qrGroup;
}

export function isMaterialTask(step: ReviewTask): boolean {
  return step.step_id === REVIEW_TASK_IDS.materialGroup;
}

export function reviewStepDecisionLabel(decision?: ReviewTaskDecision): string | null {
  if (decision === "ACKNOWLEDGED") return "已知悉，继续";
  if (decision === "MANUAL_REVIEW") return "已标记人工复核";
  return null;
}
