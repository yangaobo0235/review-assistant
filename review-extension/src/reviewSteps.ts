import type { ReviewTask } from "./types/review";

/**
 * 工作台的任务筛选规则。
 *
 * 只按后端给出的稳定 `step_id` 识别任务，**不按中文 label 推断**——
 * 文案会改，ID 不会。
 */

const QR_GROUP_STEP_ID = "QR-GROUP";
const MATERIAL_GROUP_STEP_ID = "MATERIAL-GROUP";

const RETIRED_SCRAP_FIELD_KEYS = new Set([
  "old_vehicle.affiliation",
  "new_vehicle.affiliation",
]);

/**
 * 当前报废置换工作台的前端展示策略。
 *
 * 后端仍保留历史 Profile 的材料完整性和挂靠规则；新版扩展只在这一处
 * 决定哪些任务不进入工作台，避免组件、页签和计数分别打补丁。
 */
export function isScrapReplacementTaskVisible(step: ReviewTask): boolean {
  const field = step.page_field ?? step.page_target_field;
  if (field && RETIRED_SCRAP_FIELD_KEYS.has(field)) return false;
  if (step.step_id === "FIELD-old_vehicle.affiliation" || step.step_id === "FIELD-new_vehicle.affiliation") return false;
  if (step.step_id === MATERIAL_GROUP_STEP_ID || step.step_id === "BUSINESS-MATERIAL-COMPLETENESS") return false;
  if (step.category === "MATERIAL") return false;
  if (step.step_id === "AFFILIATION-SUBJECT-001" || step.step_id.startsWith("BUSINESS-AFFILIATION-")) return false;
  return true;
}

export function isQrTask(step: ReviewTask): boolean {
  return step.step_id === QR_GROUP_STEP_ID;
}
