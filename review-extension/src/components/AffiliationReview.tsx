import type { EvidenceFact, CheckResultValue, ReviewTask } from "../types/review";

function valueText(value: unknown): string {
  if (value == null || value === "") return "未取得";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valueFor(values: CheckResultValue[], source: string): string {
  return valueText(values.find((item) => item.source === source)?.value);
}

function evidenceText(evidence: EvidenceFact): string {
  const parts = [
    evidence.source,
    evidence.field ? `字段：${evidence.field}` : "",
    evidence.source_id ? `来源：${evidence.source_id}` : "",
    evidence.image_id ? `原图：${evidence.image_id}` : "",
    evidence.document_type,
    evidence.detail,
    valueText(evidence.value),
  ]
    .filter((item) => item && item !== "未取得");
  return parts.length ? parts.join(" · ") : "后端未返回可展示的证据内容";
}

/** Render the relationship result separately so a reviewer can inspect its EvidenceFact without inferring it from a generic rule row. */
export function AffiliationReview({ step }: { step: ReviewTask }) {
  const licenseEvidence = step.evidence.filter((item) =>
    item.document_type === "business_license" || item.source.includes("营业执照"),
  );

  return (
    <section className="affiliation-review" aria-label="挂靠主体关系">
      <h3>挂靠主体关系</h3>
      <dl className="affiliation-subjects">
        <div><dt>旧车主体</dt><dd>{valueFor(step.values, "旧车所有人")}</dd></div>
        <div><dt>新车主体</dt><dd>{valueFor(step.values, "新车所有人")}</dd></div>
      </dl>
      <div className="affiliation-evidence">
        <strong>公司、执照与法人证据</strong>
        {licenseEvidence.length ? (
          <ul>
            {licenseEvidence.map((item, index) => <li key={`${item.source}-${index}`}>{evidenceText(item)}</li>)}
          </ul>
        ) : <p>本步骤未返回可关联的营业执照或法人证据；当前结论仅依据已返回信息。</p>}
      </div>
      <p className="affiliation-conclusion"><strong>关系结论</strong>{step.reason || "后端未返回关系说明"}</p>
    </section>
  );
}
