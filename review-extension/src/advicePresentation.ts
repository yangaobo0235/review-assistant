/**
 * 功能：把建议和跨材料检查转换为界面文案。
 * 职责边界：不改变检查状态或结论。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

import type {
  BusinessType,
  Recommendation,
  ReviewCheck,
  ReviewCheckStatus,
} from "./types/review";

const crossCheckDefinitions: Partial<
  Record<BusinessType, readonly { check_id: string; label: string }[]>
> = {
  scrap_replacement: [
    { check_id: "CROSS-OWNER-001", label: "新旧车所有人一致性" },
    { check_id: "CROSS-DATE-001", label: "交车与开票日期同年" },
  ],
  transfer: [
    { check_id: "CROSS-TRANSFER-SELLER-001", label: "卖方登记历史" },
    { check_id: "CROSS-TRANSFER-BUYER-001", label: "买方最新转移登记" },
    { check_id: "CROSS-TRANSFER-DATE-001", label: "开票日晚于车源发布日期" },
  ],
};

export function checkStatusLabel(status: ReviewCheckStatus): string {
  return { MATCH: "满足", CONFLICT: "不满足", INSUFFICIENT: "无法校验" }[status];
}

export function recommendationVisual(recommendation: Recommendation): {
  symbol: string;
  label: string;
} {
  return {
    PASS: { symbol: "✓", label: "审核建议：通过" },
    REVIEW_REQUIRED: { symbol: "!", label: "审核建议：需要人工复核" },
    REJECT_SUGGESTED: { symbol: "×", label: "审核建议：建议拒绝" },
  }[recommendation];
}

export function confidenceLabel(confidence: number | null | undefined): string | null {
  return confidence == null ? null : `图片识别平均置信度：${Math.round(confidence * 100)}%`;
}

export function orderedCrossChecks(
  businessType: BusinessType,
  checks: ReviewCheck[],
): ReviewCheck[] {
  const definitions = crossCheckDefinitions[businessType] || [];
  const byId = new Map(checks.map((check) => [check.check_id, check]));
  return definitions.map((definition) => byId.get(definition.check_id) || {
    ...definition,
    status: "INSUFFICIENT",
    reason: "审核流程尚未返回该项校验结果",
    values: [],
    evidence: [],
  });
}
