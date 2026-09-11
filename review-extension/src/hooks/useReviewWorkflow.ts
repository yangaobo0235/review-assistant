/**
 * 功能：管理页面采集、任务轮询和部分结果生命周期。
 * 职责边界：不渲染审核结果，不解释后端规则；挂靠写入只通过受控动作触发。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

import { useCallback, useEffect, useState } from "react";

import {
  completionNotice,
  createReviewJob,
  fetchReviewJob,
} from "../reviewClient";
import { pollReviewJob } from "../reviewJobs";
import { applyPageFillIntent, type PageFillResult } from "../pageFillClient";
import { focusReviewImage } from "../imageFocusClient";
import {
  manualBusinessSelection,
  type BusinessChoice,
} from "../reviewPanelConfig";
import type {
  PageData,
  PageFillAction,
  ReviewJobSnapshot,
  ReviewResponse,
} from "../types/review";

const reviewDeadlineMs = 60_000;
const reviewPollIntervalMs = 1_000;

async function collectPageData(selection: BusinessChoice): Promise<PageData> {
  if (!globalThis.chrome?.tabs) {
    throw new Error("请在浏览器扩展侧边栏中使用审核助手");
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) {
    throw new Error("没有找到当前页面");
  }
  const pageData = (await chrome.tabs.sendMessage(tab.id, {
    type: "COLLECT_PAGE_DATA",
    businessSelection:
      selection === "AUTO" ? null : manualBusinessSelection(selection),
  })) as Omit<PageData, "sourceTabId">;
  return { ...pageData, sourceTabId: tab.id };
}

export interface ReviewWorkflow {
  loading: boolean;
  review: ReviewResponse | null;
  job: ReviewJobSnapshot | null;
  pageData: PageData | null;
  error: string;
  notice: string;
  pageFillResult: PageFillResult | null;
  reset: () => void;
  startReview: () => Promise<void>;
  applyAffiliationFill: (actions: PageFillAction[]) => Promise<PageFillResult>;
  focusOriginalImage: (imageId: string) => Promise<void>;
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
  const [pageFillResult, setPageFillResult] = useState<PageFillResult | null>(null);

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
    setPageFillResult(null);
  }, []);

  const startReview = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    setReview(null);
    setJob(null);
    setPageFillResult(null);
    try {
      const data = await collectPageData(businessSelection);
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
      const created = await createReviewJob(data);
      const finalSnapshot = await pollReviewJob<ReviewJobSnapshot>(
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
      if (finalSnapshot.status === "FAILED") {
        throw new Error(finalSnapshot.message || "审核任务执行失败");
      }
      // The client deadline is a presentation boundary: a running snapshot still
      // contains useful partial review results and is not a transport failure.
      setNotice((current) => current || completionNotice(finalSnapshot));
    } catch (reason: unknown) {
      setError(
        reason instanceof Error ? reason.message : "审核辅助服务调用失败",
      );
    } finally {
      setLoading(false);
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

  const focusOriginalImage = useCallback(async (imageId: string) => {
    if (!pageData) {
      setNotice("没有找到原审核页面");
      return;
    }
    const response = await focusReviewImage(imageId, pageData);
    if (!response?.ok) {
      setNotice(response?.error || "原图已变化，请重新采集");
    }
  }, [pageData]);

  return {
    loading,
    review,
    job,
    pageData,
    error,
    notice,
    pageFillResult,
    reset,
    startReview,
    applyAffiliationFill,
    focusOriginalImage,
  };
}
