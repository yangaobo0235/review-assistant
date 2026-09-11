/**
 * 功能：目标业务的审核助手，只渲染当前唯一需要人工处理的页面外事项或阻塞项。
 * 职责边界：不展示正常结果、页面字段副本、完成历史，也不做任何整体建议或统计展示；
 * 当前事项处理后立即消失；人工选择只记录在前端内存。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

import type { ReviewerDecision } from "../reviewSession.ts";
import type { Evidence, ReviewCheckValue, ReviewStep } from "../types/review";

interface ScrapReplacementReviewProps {
  assistantStep: ReviewStep | null;
  blockingIssue: string | null;
  onDecide: (stepId: string, decision: ReviewerDecision) => void;
  onFocusImage: (imageId: string) => Promise<void>;
}

export function ScrapReplacementReview({ assistantStep, blockingIssue, onDecide, onFocusImage }: ScrapReplacementReviewProps) {
  if (assistantStep) {
    // 一次点击立即记录并进入下一项，不再额外点击“继续”。
    const decide = (decision: ReviewerDecision) => onDecide(assistantStep.step_id, decision);
    return (
      <section className="result-card assistant-review-issue" aria-label="当前待人工处理事项">
        <h2>{assistantStep.label}</h2>
        <p className="assistant-review-reason">{assistantStep.reason}</p>
        <ReviewValues values={assistantStep.values} />
        <ReviewImageAction evidence={assistantStep.evidence} onFocusImage={onFocusImage} />
        <div className="assistant-review-actions">
          <button type="button" onClick={() => decide("CONFIRMED")}>确认无误</button>
          <button type="button" className="assistant-review-exception" onClick={() => decide("MARKED_EXCEPTION")}>标记异常</button>
        </div>
      </section>
    );
  }
  if (blockingIssue) {
    return (
      <section className="result-card assistant-review-issue assistant-review-blocking" role="alert">
        <h2>页面审核已停止</h2>
        <p className="assistant-review-reason">{blockingIssue}</p>
      </section>
    );
  }
  return null;
}

function valueText(value: unknown): string {
  if (value == null || value === "") return "未取得";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ReviewValues({ values }: { values: ReviewCheckValue[] }) {
  if (!values || values.length === 0) return null;
  return (
    <dl className="assistant-review-values">
      {values.map((item, index) => (
        <div key={`${item.source}-${index}`}>
          <dt>{item.source}</dt>
          <dd>{valueText(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewImageAction({ evidence, onFocusImage }: { evidence: Evidence[]; onFocusImage: (imageId: string) => Promise<void> }) {
  const imageIds = [...new Set((evidence ?? []).map((item) => item.image_id).filter((imageId): imageId is string => Boolean(imageId)))];
  if (imageIds.length === 0) return null;
  return (
    <div className="assistant-review-evidence">
      {imageIds.map((imageId) => (
        <button className="evidence-focus" type="button" key={imageId} onClick={() => void onFocusImage(imageId)}>查看原图</button>
      ))}
    </div>
  );
}
