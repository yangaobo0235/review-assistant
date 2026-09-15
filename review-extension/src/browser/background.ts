import { ReviewImageNormalization } from "./image-normalization.ts";
/**
 * 功能：管理 Side Panel 行为和远程图片读取。
 * 职责边界：不采集页面字段，不执行审核规则。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */



chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  });
});

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// Content Script 受页面 CORS 限制；由具备 host permission 的后台脚本读取图片。
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "FETCH_IMAGE_ASSET" || !("url" in message) || typeof message.url !== "string") return;

  console.info("[ReviewAgent][background] image fetch start");
  fetch(message.url, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await ReviewImageNormalization.readResponseBlobWithLimit(response);
      const normalizedBlob = await ReviewImageNormalization.normalizeBlob(blob);
      const buffer = await normalizedBlob.arrayBuffer();
      sendResponse({
        ok: true,
        mimeType: normalizedBlob.type,
        sizeBytes: normalizedBlob.size,
        dataUrl: `data:${normalizedBlob.type};base64,${arrayBufferToBase64(buffer)}`
      });
      console.info("[ReviewAgent][background] image fetch complete", {
        sizeBytes: normalizedBlob.size
      });
    })
    .catch((error) => {
      console.warn("[ReviewAgent][background] image fetch failed", {
        message: error instanceof Error ? error.message : "unknown"
      });
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Image fetch failed" });
    });
  return true;
});
