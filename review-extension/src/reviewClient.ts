/**
 * 功能：封装审核任务 HTTP 请求和状态错误映射。
 * 职责边界：不保存 React 状态，不决定重试界面。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

import type {
  PageData,
  ReviewJobCreated,
  ReviewJobSnapshot,
} from "./types/review";

/** 腾讯云上的审核服务；插件安装后无需用户配置本地 Agent。 */
export const agentBaseUrl = "http://175.178.6.214:18110";

export type Fetcher = typeof fetch;

/** 创建异步审核任务，并把非成功 HTTP 状态转换为可读错误。 */
export async function createReviewJob(
  data: PageData,
  fetcher: Fetcher = fetch,
): Promise<ReviewJobCreated> {
  const response = await fetcher(`${agentBaseUrl}/api/review/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Agent 服务返回 ${response.status}`);
  }
  return (await response.json()) as ReviewJobCreated;
}

/** 返回任务最新快照；任务不存在时提供区别于一般请求失败的错误。 */
export async function fetchReviewJob(
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<ReviewJobSnapshot> {
  const response = await fetcher(`${agentBaseUrl}/api/review/jobs/${jobId}`);
  if (response.status === 404) {
    throw new Error("审核任务不存在，Agent 可能已重启");
  }
  if (!response.ok) {
    throw new Error(`审核进度查询失败 ${response.status}`);
  }
  return (await response.json()) as ReviewJobSnapshot;
}

export function completionNotice(
  snapshot: Pick<ReviewJobSnapshot, "status">,
): string {
  if (snapshot.status === "RUNNING") {
    return "已达到 60 秒审核目标，以下为当前已完成结果，剩余资料请人工复核";
  }
  if (snapshot.status === "PARTIAL") {
    return "部分资料未在时限内完成，已完成结果可先供审核参考";
  }
  return "";
}
