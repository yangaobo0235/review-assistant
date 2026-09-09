import { materialIssuePresentation, retryNotices } from "../materialCompletenessPresentation";
import type { MaterialCompletenessReport, RetrySummary } from "../types/review";

export function MaterialCompleteness({ report, retrySummary }: { report?: MaterialCompletenessReport | null; retrySummary?: RetrySummary | null }) {
  const notices = retryNotices(retrySummary);
  if (!report && !notices.length) return null;
  const status = report?.status === "COMPLETE" ? "材料齐全" : report?.status === "INCOMPLETE" ? "材料不完整" : "材料待确认";
  return (
    <section className="result-card material-completeness">
      <div className="group-heading"><h2>材料完整性</h2><small>{status}</small></div>
      {report?.issues.map((issue, index) => {
        const item = materialIssuePresentation(issue);
        return <article key={`${issue.code}-${index}`}>
          <strong>{item.title}</strong>
          {item.reason ? <p>{item.reason}</p> : null}
          <p className="muted">处理建议：{item.action}</p>
        </article>;
      })}
      {notices.map((notice) => <p className="muted" key={notice}>{notice}</p>)}
    </section>
  );
}
