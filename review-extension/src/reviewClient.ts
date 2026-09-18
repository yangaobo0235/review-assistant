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

export const localAgentBaseUrl = "http://127.0.0.1:8010";
export const publicAgentBaseUrl = "http://175.178.6.214:18110";

declare const __REVIEW_AGENT_BUILD_MODE__: string | undefined;
declare const __REVIEW_AGENT_BASE_URL__: string | undefined;

/** 根据构建模式选择 Agent；显式 VITE_AGENT_BASE_URL 可覆盖预设地址。 */
export function resolveAgentBaseUrl(
  mode: string | undefined,
  configuredUrl: string | undefined,
): string {
  const normalizedUrl = configuredUrl?.trim().replace(/\/+$/, "");
  if (normalizedUrl) return normalizedUrl;
  return mode === "public" ? publicAgentBaseUrl : localAgentBaseUrl;
}

export const agentBaseUrl = resolveAgentBaseUrl(
  typeof __REVIEW_AGENT_BUILD_MODE__ === "string"
    ? __REVIEW_AGENT_BUILD_MODE__
    : undefined,
  typeof __REVIEW_AGENT_BASE_URL__ === "string"
    ? __REVIEW_AGENT_BASE_URL__
    : undefined,
);

export type Fetcher = typeof fetch;

function withoutImagePayload(image: PageData["images"][number]) {
  return {
    ...image,
    src: image.src?.startsWith("data:") ? "" : image.src,
    dataUrl: null,
  };
}

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

/** 创建流式审核任务；请求只携带页面字段和图片清单，不上传图片内容。 */
export async function createStreamReviewJob(
  data: PageData,
  fetcher: Fetcher = fetch,
): Promise<ReviewJobCreated> {
  const images = data.images.map(withoutImagePayload);
  const response = await fetcher(`${agentBaseUrl}/api/review/jobs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, images }),
  });
  if (!response.ok) throw new Error(`流式审核任务创建失败 ${response.status}`);
  return (await response.json()) as ReviewJobCreated;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, encoded] = dataUrl.split(",", 2);
  if (!header || encoded == null) throw new Error("图片数据格式无效");
  const mimeType = /^data:([^;]+)/.exec(header)?.[1] || "image/jpeg";
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

/** 单张上传规范化图片；二进制传输避免 Base64 在公网链路上的体积开销。 */
export async function uploadStreamReviewImage(
  jobId: string,
  image: PageData["images"][number],
  fetcher: Fetcher = fetch,
): Promise<ReviewJobSnapshot> {
  const form = new FormData();
  form.append("metadata", JSON.stringify(withoutImagePayload(image)));
  if (image.dataUrl && !image.collectionError) {
    form.append("file", dataUrlToBlob(image.dataUrl), `${image.imageId || image.index}.jpg`);
  }
  const response = await fetcher(`${agentBaseUrl}/api/review/jobs/${jobId}/images`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(`图片上传失败 ${response.status}`);
  return (await response.json()) as ReviewJobSnapshot;
}

export async function completeStreamReviewJob(
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<ReviewJobSnapshot> {
  const response = await fetcher(`${agentBaseUrl}/api/review/jobs/${jobId}/complete`, { method: "POST" });
  if (!response.ok) throw new Error(`结束图片上传失败 ${response.status}`);
  return (await response.json()) as ReviewJobSnapshot;
}

export async function cancelReviewJob(jobId: string, fetcher: Fetcher = fetch): Promise<void> {
  await fetcher(`${agentBaseUrl}/api/review/jobs/${jobId}`, { method: "DELETE" });
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
    return "已达到 120 秒审核上限，以下为当前已完成结果，剩余资料请人工复核";
  }
  if (snapshot.status === "PARTIAL") {
    return "部分资料未在时限内完成，已完成结果可先供审核参考";
  }
  return "";
}
