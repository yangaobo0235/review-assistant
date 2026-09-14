import type { MaterialCompletenessIssue, RetrySummary } from "./types/review";

const FIELD_LABELS: Record<string, string> = {
};

const SOURCE_LABELS: Record<string, string> = {
  page: "申请页面",
  invoice: "二手车发票",
  registration_certificate: "登记证第 2 页",
};

const MATERIAL_LABELS: Record<string, string> = {
  scrap_certificate: "报废机动车回收证明",
  vehicle_license: "行驶证",
  registration_certificate: "机动车登记证书",
  invoice: "机动车销售发票",
};

function translateMaterialNames(text: string): string {
  return Object.entries(MATERIAL_LABELS).reduce(
    (result, [technicalName, displayName]) => result.split(technicalName).join(displayName),
    text,
  );
}

export function materialIssuePresentation(issue: MaterialCompletenessIssue) {
  const pages = issue.missing_pages?.join("、");
  const sources = issue.missing_sources?.map((source) => SOURCE_LABELS[source] ?? source).join("、");
  const field = issue.field ? FIELD_LABELS[issue.field] ?? issue.field : null;
  const title = issue.code === "MISSING_REGISTRATION_PAGES" && pages
    ? `登记证第 ${pages} 页未能确认`
    : issue.code === "MISSING_FIELD_SOURCE" && field
      ? `${field}证据不完整`
    : translateMaterialNames(issue.message);
  const reasonParts = [sources ? `缺少来源：${sources}` : null, issue.reason_detail].filter(Boolean);
  return {
    title,
    reason: reasonParts.length ? reasonParts.join("。") : null,
    action: issue.suggested_action,
  };
}

export function retryNotices(summary?: RetrySummary | null): string[] {
  if (!summary) return [];
  return summary.attempts
    .filter((attempt) => attempt.attempt_number > 1)
    .map((attempt) => {
      const result = attempt.result === "succeeded" ? "成功" : attempt.result === "skipped" ? "已跳过" : "未成功";
      if (attempt.stage === "qwen") return `资料 ${attempt.target_id} 已重新识别：${result}`;
      if (attempt.stage === "qr_web") return `二维码官网已重新核验：${result}`;
      return `二维码已执行第 ${attempt.attempt_number} 轮处理：${result}`;
    });
}
