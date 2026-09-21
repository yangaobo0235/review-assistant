/**
 * 功能：管理页面采集、任务轮询和部分结果生命周期。
 * 职责边界：不渲染审核结果，不解释后端规则；挂靠写入只通过受控动作触发。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

import { useCallback, useEffect, useState } from "react";

import { applyCollectManifest, fetchCollectManifest } from "../browser/collect-manifest.ts";
import type { CollectManifest } from "../browser/collect-manifest.ts";
import { fetchPageCatalog } from "../browser/page-catalog.ts";
import type { PageCatalog } from "../browser/page-catalog.ts";
import {
  agentBaseUrl,
  cancelReviewJob,
  completionNotice,
  completeStreamReviewJob,
  createStreamReviewJob,
  fetchReviewJob,
  uploadStreamReviewImage,
} from "../reviewClient";
import { pollReviewJob } from "../reviewJobs";
import { applyPageFieldGroupValue, applyPageFieldValue, applyPageFillIntent, verifyInvoice, type PageFillResult } from "../pageFillClient";
import { focusReviewImage, type ImageFocusResult } from "../imageFocusClient";
import { PageActionRegistry } from "../session/pageActionRegistry";
import {
  manifestBusinessTypes,
  manualBusinessSelection,
  type BusinessChoice,
} from "../reviewPanelConfig";
import type {
  PageData,
  PageFillAction,
  ReviewJobSnapshot,
  ReviewResponse,
  PageActionIntent,
} from "../types/review";

const reviewDeadlineMs = 120_000;
const reviewPollIntervalMs = 1_000;
const imageUploadConcurrency = 2;

/**
 * 拉取各业务的采集清单。某个业务拉不到就跳过——Content Script 会退回内置表，
 * 采集不会因为清单不可用而中断。
 */
async function loadCollectManifests(): Promise<CollectManifest[]> {
  const results = await Promise.all(
    manifestBusinessTypes.map((business) => fetchCollectManifest(agentBaseUrl, business)),
  );
  return results.filter((item): item is CollectManifest => item !== null);
}

async function collectPageData(selection: BusinessChoice): Promise<PageData> {
  if (!globalThis.chrome?.tabs) {
    throw new Error("请在浏览器扩展侧边栏中使用审核助手");
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) {
    throw new Error("没有找到当前页面");
  }
  const manifests = await loadCollectManifests();
  // 页面识别清单和采集清单一起拉：识别发生在按业务类型取采集清单之前，
  // 所以它必须一次下发全部业务，不能按业务类型查。拉不到时为 null，
  // Content Script 退回内置表并要求人工选择业务。
  const pageCatalog: PageCatalog | null = await fetchPageCatalog(agentBaseUrl);
  const pageData = (await chrome.tabs.sendMessage(tab.id, {
    type: "COLLECT_PAGE_MANIFEST",
    businessSelection:
      selection === "AUTO" ? null : manualBusinessSelection(selection),
    // 后端是字段别名和页面分组标题的唯一来源。拉取失败时下发空数组，
    // Content Script 会退回内置表，采集照常进行。
    collectManifests: manifests,
    pageCatalog,
  })) as Omit<PageData, "sourceTabId">;
  // 侧边栏和 Content Script 是两个独立的 JS 运行时，Content Script 里应用的
  // 清单不会传到这里。面板重新应用同一份，用于把字段键和材料类型显示成中文；
  // 采集判定仍然只发生在 Content Script。
  applyCollectManifest(
    manifests.find((item) => item.business_type === pageData.businessType),
  );
  return { ...pageData, sourceTabId: tab.id };
}

async function readPageImage(page: PageData, image: PageData["images"][number]) {
  try {
    const result = await chrome.tabs.sendMessage(page.sourceTabId, {
      type: "READ_REVIEW_IMAGE",
      imageId: image.imageId,
      expectedCollectionId: page.collectionId,
    });
    if (!result?.ok || !result.image) {
      return { ...image, dataUrl: null, collectionError: result?.error || "图片读取失败" };
    }
    return result.image as PageData["images"][number];
  } catch (error) {
    return {
      ...image,
      dataUrl: null,
      collectionError: error instanceof Error ? error.message : "图片读取失败",
    };
  }
}

async function uploadPageImages(
  page: PageData,
  jobId: string,
  onImage: (image: PageData["images"][number], completed: number) => void,
  onSnapshot: (snapshot: ReviewJobSnapshot) => void,
) {
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < page.images.length) {
      const index = cursor;
      cursor += 1;
      const image = await readPageImage(page, page.images[index]);
      let snapshot: ReviewJobSnapshot | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          snapshot = await uploadStreamReviewImage(jobId, image);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!snapshot) throw lastError instanceof Error ? lastError : new Error("图片上传失败");
      completed += 1;
      // 保留压缩后的图片供结果页显示缩略图；data: 原地址则清空，避免
      // 在页面状态中同时保存原图和压缩图两份正文。
      onImage({ ...image, src: image.src.startsWith("data:") ? "" : image.src }, completed);
      onSnapshot(snapshot);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(imageUploadConcurrency, Math.max(1, page.images.length)) }, worker),
  );
}

export interface ReviewWorkflow {
  loading: boolean;
  review: ReviewResponse | null;
  job: ReviewJobSnapshot | null;
  pageData: PageData | null;
  error: string;
  notice: string;
  stageMessage: string;
  reset: () => void;
  startReview: () => Promise<void>;
  applyAffiliationFill: (actions: PageFillAction[]) => Promise<PageFillResult>;
  applyPageFieldValue: (field: string, value: string, expectedValue?: string | null) => Promise<PageFillResult>;
  applyPageFieldGroupValue: (fields: string[], value: string, expectedValues?: Record<string, string | null | undefined>) => Promise<PageFillResult>;
  focusOriginalImage: (imageId: string) => Promise<ImageFocusResult>;
}

/** 管理一次审核从页面采集到最终或部分结果的完整客户端生命周期。 */
export function useReviewWorkflow(
  businessSelection: BusinessChoice,
): ReviewWorkflow {
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [job, setJob] = useState<ReviewJobSnapshot | null>(null);
  const [pageData, setPageData] = useState<PageData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stageMessage, setStageMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void collectPageData(businessSelection)
      .then((data) => {
        if (cancelled) return;
        setPageData(data);
        if (data.businessDetectionError) {
          setError(data.businessDetectionError);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "页面采集失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [businessSelection]);

  const reset = useCallback(() => {
    setReview(null);
    setJob(null);
    setPageData(null);
    setError("");
    setNotice("");
    setStageMessage("");
  }, []);

  const startReview = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    setReview(null);
    setJob(null);
    setStageMessage("正在读取页面和图片清单……");
    let activeJobId = "";
    try {
      const data = await collectPageData(businessSelection);
      if (data.staleCollection) {
        // 被取代的采集：透出真实的过期原因，而不是退化为业务识别失败。
        throw new Error(
          data.collectionIssues?.[0] || "页面采集已过期，请重新采集",
        );
      }
      if (!data.businessType) {
        throw new Error(
          data.businessDetectionError || "无法识别当前审核业务，请人工选择",
        );
      }
      setPageData(data);
      console.info(
        "[ReviewAgent][panel] page collected",
        data.collectionDiagnostics,
      );
      setStageMessage(`已发现 ${data.images.length} 张图片，正在创建审核任务……`);
      const created = await createStreamReviewJob(data);
      activeJobId = created.job_id;
      setStageMessage(`正在压缩并上传图片 0/${data.images.length}`);
      const polling = pollReviewJob<ReviewJobSnapshot>(
        () => fetchReviewJob(created.job_id),
        (snapshot) => {
          setJob(snapshot);
          if (snapshot.result) setReview(snapshot.result);
        },
        {
          timeoutMs: reviewDeadlineMs,
          intervalMs: reviewPollIntervalMs,
        },
      );
      // 上传与轮询并行；立即挂载拒绝处理，避免上传阶段较长时轮询错误
      // 被浏览器提前报告为未处理的 Promise rejection。稍后仍 await 原 Promise。
      void polling.catch(() => undefined);
      await uploadPageImages(
        data,
        created.job_id,
        (image, completed) => {
          setStageMessage(`正在压缩并上传图片 ${completed}/${data.images.length}`);
          setPageData((current) => current?.collectionId === data.collectionId
            ? { ...current, images: current.images.map((item) =>
              (item.imageId || item.index) === (image.imageId || image.index) ? image : item) }
            : current);
        },
        (snapshot) => setJob(snapshot),
      );
      setStageMessage("图片上传完成，正在识别并生成审核结论……");
      setJob(await completeStreamReviewJob(created.job_id));
      const finalSnapshot = await polling;
      if (finalSnapshot.status === "FAILED") {
        throw new Error(finalSnapshot.message || "审核任务执行失败");
      }
      if (finalSnapshot.status === "CANCELLED") throw new Error("审核任务已取消");
      if (finalSnapshot.status !== "RUNNING") activeJobId = "";
      const actionResults = await executePageActions(finalSnapshot.result?.page_actions ?? [], data);
      if (actionResults.length) setNotice(actionResults.join("；"));
      // The client deadline is a presentation boundary: a running snapshot still
      // contains useful partial review results and is not a transport failure.
      setNotice((current) => current || completionNotice(finalSnapshot));
    } catch (reason: unknown) {
      if (activeJobId) void cancelReviewJob(activeJobId);
      setError(
        reason instanceof Error ? reason.message : "审核辅助服务调用失败",
      );
    } finally {
      setLoading(false);
      setStageMessage("");
    }
  }, [businessSelection, loading]);

  const applyAffiliationFill = useCallback(async (actions: PageFillAction[]) => {
    if (!pageData) return { ok: false, message: "没有找到原审核页面" };
    return applyPageFillIntent(actions, {
      tabId: pageData.sourceTabId,
      pageUrl: pageData.pageUrl,
      pageInstanceId: pageData.pageInstanceId,
      pageFingerprint: pageData.pageFingerprint,
      collectionId: pageData.collectionId,
    });
  }, [pageData]);

  const applyFieldValue = useCallback(async (field: string, value: string, expectedValue?: string | null) => {
    if (!pageData) return { ok: false, message: "没有找到原审核页面" };
    const result = await applyPageFieldValue({ field, value, expectedValue }, {
      tabId: pageData.sourceTabId,
      pageUrl: pageData.pageUrl,
      pageInstanceId: pageData.pageInstanceId,
      pageFingerprint: pageData.pageFingerprint,
      collectionId: pageData.collectionId,
    });
    if (result.ok || (result.code === "FIELD_VALUE_CHANGED" && result.currentValue != null)) setPageData((current) => current?.collectionId === pageData.collectionId
      ? { ...current, pageFields: { ...current.pageFields, [field]: result.ok ? result.actions?.[0]?.value ?? value : result.currentValue as string } }
      : current);
    return result;
  }, [pageData]);

  const applyFieldGroupValue = useCallback(async (fields: string[], value: string, expectedValues?: Record<string, string | null | undefined>) => {
    if (!pageData) return { ok: false, message: "没有找到原审核页面" };
    const expected = expectedValues || Object.fromEntries(fields.map((field) => [field, pageData.pageFields[field] ?? null]));
    const result = await applyPageFieldGroupValue({ fields, value, expectedValues: expected }, {
      tabId: pageData.sourceTabId,
      pageUrl: pageData.pageUrl,
      pageInstanceId: pageData.pageInstanceId,
      pageFingerprint: pageData.pageFingerprint,
      collectionId: pageData.collectionId,
    });
    if (result.ok) {
      setPageData((current) => current?.collectionId === pageData.collectionId
        ? { ...current, pageFields: { ...current.pageFields, ...Object.fromEntries(fields.map((field) => [field, value])) } }
        : current);
    }
    return result;
  }, [pageData]);

  const focusOriginalImage = useCallback(async (imageId: string) => {
    if (!pageData) {
      const failure = { ok: false, error: "没有找到原审核页面" };
      setNotice(failure.error);
      return failure;
    }
    // 无论成功还是失败都把结果交回调用方：面板顶部的提示离字段卡片很远，
    // 只在那里报错等于"点了没反应"。详情卡片会把结果显示在卡片旁边。
    const response = await focusReviewImage(imageId, pageData);
    if (!response?.ok) setNotice(response?.error || "原图已变化，请重新采集");
    return response ?? { ok: false, error: "原图已变化，请重新采集" };
  }, [pageData]);

  return {
    loading,
    review,
    job,
    pageData,
    error,
    notice,
    stageMessage,
    reset,
    startReview,
    applyAffiliationFill,
    applyPageFieldValue: applyFieldValue,
    applyPageFieldGroupValue: applyFieldGroupValue,
    focusOriginalImage,
  };
}

async function executePageActions(actions: readonly PageActionIntent[], data: PageData): Promise<string[]> {
  const registry = new PageActionRegistry();
  registry.register("verify_invoice", async (_action, page) => {
    const verification = await verifyInvoice({
      tabId: page.sourceTabId,
      pageUrl: page.pageUrl,
      pageInstanceId: page.pageInstanceId,
      pageFingerprint: page.pageFingerprint,
      collectionId: page.collectionId,
    });
    return verification.ok ? "发票号码核验通过，已点击一键验真" : (verification.message || "发票号码已通过比对，但未找到一键验真按钮");
  });
  return registry.executeAll(actions, data);
}
