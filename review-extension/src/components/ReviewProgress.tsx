/**
 * 功能：展示审核任务进度和分组状态。
 * 职责边界：只消费任务快照，不修改任务状态。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

import type { ReviewJobSnapshot } from "../types/review";

export function ReviewProgress({ job }: { job: ReviewJobSnapshot }) {
  const processed = job.progress.completed_count + job.progress.failed_count + job.progress.timed_out_count;
  const totalSteps = job.progress.total_count * 2;
  const percent = totalSteps
    ? Math.min(100, Math.round(((job.progress.uploaded_count + processed) / totalSteps) * 100))
    : job.phase === "FINALIZING" || job.phase === "COMPLETED" ? 100 : 0;
  const phaseText = {
    PREPARING: "正在准备审核任务",
    UPLOADING: "正在压缩并上传图片",
    RECOGNIZING: "正在识别图片",
    FINALIZING: "正在生成审核结论",
    COMPLETED: "审核已完成",
    FAILED: "审核失败",
    CANCELLED: "审核已取消",
  }[job.phase];
  return (
    <div className="review-progress">
      <div className="review-progress-heading"><strong>审核进度</strong><span>{phaseText}</span></div>
      <div
        className="review-progress-track"
        role="progressbar"
        aria-label="审核图片处理进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="review-progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <small>已上传 {job.progress.uploaded_count}/{job.progress.total_count} · 已识别 {processed}/{job.progress.total_count}</small>
      {job.progress.failed_count > 0 || job.progress.timed_out_count > 0 ? (
        <small>失败 {job.progress.failed_count} 张，超时 {job.progress.timed_out_count} 张</small>
      ) : null}
    </div>
  );
}
