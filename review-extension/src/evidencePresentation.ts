/**
 * 功能：生成证据来源和冲突高亮展示计划。
 * 职责边界：不改变原始证据值。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

import type { Evidence } from "./types/review";

export interface EvidenceHighlightPlan {
  compareTo?: string;
  markAll?: boolean;
}

/** 为每条证据生成多数基准、双向比较或整体冲突的展示计划。 */
export function evidenceHighlightPlans(
  evidence: Evidence[],
): EvidenceHighlightPlan[] {
  const valid = evidence
    .map((item, index) => ({ item, index, value: String(item.value ?? "") }))
    .filter(({ value }) => value.trim());
  const majority = valid.find(({ item }) => item.conflicting === false);

  if (majority) {
    return evidence.map((item) =>
      item.conflicting === true ? { compareTo: majority.value } : {},
    );
  }

  if (valid.length === 2 && valid.every(({ item }) => item.conflicting === true)) {
    const targets = new Map([
      [valid[0].index, valid[1].value],
      [valid[1].index, valid[0].value],
    ]);
    return evidence.map((_, index) => {
      const compareTo = targets.get(index);
      return compareTo === undefined ? {} : { compareTo };
    });
  }

  if (valid.length > 2 && valid.every(({ item }) => item.conflicting === true)) {
    const validIndices = new Set(valid.map(({ index }) => index));
    return evidence.map((_, index) => validIndices.has(index) ? { markAll: true } : {});
  }

  return evidence.map(() => ({}));
}

export function comparisonEvidence(
  evidence: Evidence[],
  pageValue: string | number | null | undefined,
): Evidence[] {
  const valid = evidence.filter(
    (item) => item.value != null && String(item.value).trim(),
  );
  const pageSources = new Set(["页面右侧字段", "申请页面字段"]);
  const imageEvidence = valid
    .filter((item) => !pageSources.has(item.source))
    .sort((left, right) => {
      const priority = (item: Evidence) =>
        item.document_type === "invoice" ? 0
          : item.document_type === "registration_certificate" ? 1
            : 2;
      return priority(left) - priority(right);
    });
  const pageEvidence = valid.filter(
    (item) => pageSources.has(item.source),
  );
  if (pageEvidence.length) return [...pageEvidence, ...imageEvidence];
  return [
    {
      source: "页面右侧字段",
      value:
        pageValue != null && String(pageValue).trim() ? pageValue : "未采集",
    },
    ...imageEvidence,
  ];
}

export function evidencePresentation(evidence: Pick<Evidence, "source" | "value" | "document_type" | "business_scope" | "group_order">) {
  const value = String(evidence.value);
  if (evidence.source === "页面右侧字段" || evidence.source === "申请页面字段") {
    return { kind: "page" as const, label: "申请页面", value };
  }
  if (evidence.source === "二维码官网字段") {
    return { kind: "page" as const, label: "二维码官网", value };
  }
  if (evidence.document_type === "invoice") {
    const label = evidence.business_scope === "transfer" ? "二手车发票" : "机动车销售发票";
    return { kind: "image" as const, label, value };
  }
  if (evidence.document_type === "registration_certificate") {
    const label = evidence.business_scope === "transfer" && evidence.group_order
      ? `登记证第${evidence.group_order}页`
      : "机动车登记证书";
    return { kind: "image" as const, label, value };
  }
  if (evidence.document_type === "vehicle_license") {
    return { kind: "image" as const, label: "行驶证", value };
  }
  if (evidence.document_type === "scrap_certificate") {
    return { kind: "image" as const, label: "报废机动车回收证明", value };
  }
  if (evidence.document_type === "business_license") {
    return { kind: "image" as const, label: "营业执照", value };
  }
  if (evidence.document_type === "identity_card") {
    return { kind: "image" as const, label: "身份证", value };
  }
  return { kind: "image" as const, label: "图片证据", value };
}
