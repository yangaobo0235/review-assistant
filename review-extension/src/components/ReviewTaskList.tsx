import type { ReviewTask } from "../types/review";

/** Generic renderer for backend routed tasks; it contains no business rules. */
export function ReviewTaskList({ tasks }: { tasks: readonly ReviewTask[] }) {
  if (!tasks.length) return null;
  return (
    <section className="result-card review-task-list">
      <div className="group-heading"><h2>审核任务</h2><small>{tasks.length} 项</small></div>
      {tasks.map((task) => (
        <article className={`check-row status-${task.result_status.toLowerCase()}`} key={task.step_id}>
          <span>{task.sequence}. {task.label}</span>
          <strong>{task.result_status === "MATCH" ? "通过" : "待处理"}</strong>
          <p className="muted">{task.reason}</p>
        </article>
      ))}
    </section>
  );
}

