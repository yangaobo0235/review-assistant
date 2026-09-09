export type PollableJobStatus = "RUNNING" | "PARTIAL" | "COMPLETED" | "FAILED";

export interface PollableJobSnapshot {
  status: PollableJobStatus;
  progress: {
    completed_count: number;
    total_count: number;
  };
}

interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
}

const terminalStatuses = new Set<PollableJobStatus>(["PARTIAL", "COMPLETED", "FAILED"]);

export async function pollReviewJob<T extends PollableJobSnapshot>(
  fetchSnapshot: () => Promise<T>,
  onSnapshot: (snapshot: T) => void,
  options: PollOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let latest: T | undefined;

  while (now() - startedAt < timeoutMs) {
    latest = await fetchSnapshot();
    onSnapshot(latest);
    if (terminalStatuses.has(latest.status)) return latest;
    if (intervalMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }
  }
  if (latest) return latest;
  throw new Error("审核任务未返回进度");
}
