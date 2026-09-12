import type { PageFillAction, PageWriteAction } from "./types/review";

export interface PageFillResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
  actions?: Array<{ field: string; label: string; value: string; status: string }>;
}

interface ChromeTabsLike {
  tabs: {
    sendMessage?(tabId: number, message: unknown): Promise<PageFillResult>;
  };
}

export interface PageFillTarget {
  tabId: number;
  pageUrl: string;
  pageInstanceId: string;
  pageFingerprint: string;
  collectionId: string;
}

export async function applyPageFillIntent(
  actions: PageFillAction[],
  target: PageFillTarget,
  chromeApi: ChromeTabsLike = globalThis.chrome,
): Promise<PageFillResult> {
  if (!actions.length) return { ok: true, skipped: true, message: "本次审核没有页面填写动作" };
  if (!Number.isInteger(target.tabId) || !target.pageUrl || !target.pageInstanceId || !target.pageFingerprint || !target.collectionId || !chromeApi.tabs.sendMessage) {
    return { ok: false, message: "原审核页面标识不完整，请重新审核" };
  }
  return chromeApi.tabs.sendMessage(target.tabId, {
    type: "APPLY_PAGE_FILL_INTENT", actions,
    expectedPageUrl: target.pageUrl, expectedPageInstanceId: target.pageInstanceId, expectedPageFingerprint: target.pageFingerprint,
    expectedCollectionId: target.collectionId,
  });
}

export async function applyPageFieldValue(
  action: PageWriteAction,
  target: PageFillTarget,
  chromeApi: ChromeTabsLike = globalThis.chrome,
): Promise<PageFillResult> {
  if (!action.field || !action.value) return { ok: false, message: "回填值不能为空" };
  if (!Number.isInteger(target.tabId) || !target.pageUrl || !target.pageInstanceId || !target.pageFingerprint || !target.collectionId || !chromeApi.tabs.sendMessage) {
    return { ok: false, message: "原审核页面标识不完整，请重新审核" };
  }
  return chromeApi.tabs.sendMessage(target.tabId, {
    type: "APPLY_PAGE_FIELD_VALUE",
    action,
    expectedPageUrl: target.pageUrl,
    expectedPageInstanceId: target.pageInstanceId,
    expectedPageFingerprint: target.pageFingerprint,
    expectedCollectionId: target.collectionId,
  });
}
