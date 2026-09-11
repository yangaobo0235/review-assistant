export interface ImageFocusResult {
  ok: boolean;
  error?: string;
}

export interface ImageFocusTarget {
  sourceTabId: number;
  pageUrl: string;
  pageInstanceId: string;
  pageFingerprint: string;
  collectionId: string;
}

interface ChromeTabsLike {
  tabs: {
    sendMessage?(tabId: number, message: unknown): Promise<ImageFocusResult>;
  };
}

export async function focusReviewImage(
  imageId: string,
  target: ImageFocusTarget,
  chromeApi: ChromeTabsLike = globalThis.chrome,
): Promise<ImageFocusResult> {
  if (!imageId || !Number.isInteger(target.sourceTabId) || !target.pageUrl || !target.pageInstanceId || !target.pageFingerprint || !target.collectionId || !chromeApi.tabs.sendMessage) {
    return { ok: false, error: "原审核页面标识不完整，请重新采集" };
  }
  return chromeApi.tabs.sendMessage(target.sourceTabId, {
    type: "FOCUS_REVIEW_IMAGE",
    imageId,
    expectedPageUrl: target.pageUrl,
    expectedPageInstanceId: target.pageInstanceId,
    expectedPageFingerprint: target.pageFingerprint,
    expectedCollectionId: target.collectionId,
  });
}
