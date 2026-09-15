import type { ReviewResponse } from "../types/review";
import { ReviewTaskList } from "./ReviewTaskList";

/** Generic task renderer used by profiles without a page-specific workbench. */
export function ReviewTaskWorkbench({ review }: { review: ReviewResponse }) {
  const tasks = review.review_tasks || [];
  return (
    <section className="review-result review-task-workbench" aria-label="审核任务">
      <ReviewTaskList tasks={tasks} />
      {tasks.map((task) => (
        <article className="result-card" key={task.step_id}>
          <div className="group-heading">
            <h2>{task.label}</h2>
            <small>{task.result_status === "MATCH" ? "通过" : "需要复核"}</small>
          </div>
          <p>{task.reason}</p>
        </article>
      ))}
    </section>
  );
}
