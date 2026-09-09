/**
 * 功能：展示审核任务进度和分组状态。
 * 职责边界：只消费任务快照，不修改任务状态。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

import type { ReviewJobSnapshot } from "../types/review";

export function ReviewProgress({ job }: { job: ReviewJobSnapshot }) {
  const percent = job.progress.total_count
    ? Math.min(100, Math.round((job.progress.completed_count / job.progress.total_count) * 100))
    : 0;
  return (
    <div className="review-progress">
      <div className="review-progress-heading"><strong>审核进度</strong></div>
      <div
        className="review-progress-track"
        role="progressbar"
        aria-label="审核图片处理进度"
        aria-valuemin={0}
        aria-valuemax={job.progress.total_count}
        aria-valuenow={job.progress.completed_count}
      >
        <div className="review-progress-bar" style={{ width: `${percent}%` }} />
      </div>
      {job.progress.failed_count > 0 || job.progress.timed_out_count > 0 ? (
        <small>失败 {job.progress.failed_count} 张，超时 {job.progress.timed_out_count} 张</small>
      ) : null}
    </div>
  );
}
