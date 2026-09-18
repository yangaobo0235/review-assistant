import { ReviewBusinessDetector } from "./business-detector.ts";
import { ReviewBusinessScope } from "./business-scope.ts";
import { ReviewImageCandidates } from "./image-candidates.ts";
import { ReviewImageFocus } from "./image-focus.ts";
import { ReviewImageNormalization } from "./image-normalization.ts";
import { ReviewPageFieldCollector } from "./page-field-collector.ts";
import { ReviewPageFieldWriter } from "./page-field-writer.ts";
import { buildPageFingerprint, createPageInstanceId } from "./page-identity.ts";
import type { BusinessSelection, PageFillAction, PageImage, PageWriteGroupAction } from "../types/review.ts";
/**
 * 功能：协调页面采集、图片标准化和原图定位消息。
 * 职责边界：复杂识别逻辑委托给独立公共脚本；DOM 元素不跨消息传输。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

// Keep collection orchestration here; field, image, normalization, and focus rules live in dedicated scripts.
const reviewImageElements = new Map();
const reviewImageCandidates = new Map<string, { collectionId: string; candidate: ImageSelection }>();
const reviewFieldElements = new Map();
const verifiedFieldWrites = new Map();
const MAX_REVIEW_IMAGES = 16;
const pageInstanceId = createPageInstanceId();
let activeCollectionId = "";
let latestCollectionId = "";
let collectionSequence = 0;
const nextCollectionId = () => `${pageInstanceId}:${++collectionSequence}`;
const pageFingerprint = buildPageFingerprint;
const MESSAGE_TYPES = Object.freeze({
  collectPageData: "COLLECT_PAGE_DATA",
  collectPageManifest: "COLLECT_PAGE_MANIFEST",
  readReviewImage: "READ_REVIEW_IMAGE",
  focusReviewImage: "FOCUS_REVIEW_IMAGE",
  applyPageFillIntent: "APPLY_PAGE_FILL_INTENT",
  applyPageFieldValue: "APPLY_PAGE_FIELD_VALUE",
  applyPageFieldGroupValue: "APPLY_PAGE_FIELD_GROUP_VALUE",
  verifyInvoice: "VERIFY_INVOICE",
});
type ReviewMessage = {
  type?: string; expectedPageUrl?: string; expectedPageInstanceId?: string; expectedPageFingerprint?: string; expectedCollectionId?: string;
  action?: { field?: string; value?: string; expectedValue?: string | null }; actions?: unknown[]; imageId?: string; businessSelection?: unknown;
  [key: string]: unknown;
};
type CollectionSnapshot = { pageFields?: Record<string, string>; fieldTargets?: Array<{ field: string; element: Element }> };
type ImageSelection = { image: HTMLImageElement; index: number; imageId?: string; businessScope: string; groupOrder?: number; categoryHint?: string; groupTitle?: string };

const classifyImage = (hint: string) => {
  const text = hint.toLowerCase();
  if (text.includes("身份证")) return "id_card";
  if (text.includes("营业执照")) return "business_license";
  if (text.includes("登记证书") || text.includes("机动车登记证")) return "registration_certificate";
  if (text.includes("回收证明") || text.includes("报废证明")) return "scrap_certificate";
  if (text.includes("发票")) return "invoice";
  if (text.includes("报废车辆资料") || text.includes("报废车辆信息") || text.includes("报废车资料") || text.includes("旧车资料")) return "old_vehicle";
  if (text.includes("新车资料") || text.includes("新车及发票信息") || text.includes("新车及发票资料")) return "new_vehicle";
  return "unknown";
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
  reader.onerror = () => reject(new Error("图片转换失败"));
  reader.readAsDataURL(blob);
});

const imageAssetMetadata = (candidate: ImageSelection): PageImage => {
  const { image, index } = candidate;
  const src = image.currentSrc || image.src;
  const hint = image.closest("section, article, li, div")?.textContent?.slice(0, 160) || image.alt || "";
  return {
    imageId: candidate.imageId,
    index,
    src,
    alt: image.alt || "",
    group: hint.slice(0, 80) || "未分类",
    categoryHint: classifyImage(hint),
    documentTypeHint: ReviewBusinessScope.documentTypeFor?.(
      candidate.businessScope,
      candidate.groupOrder ?? 0,
      candidate.categoryHint || "",
    ) || candidate.categoryHint,
    businessScope: candidate.businessScope,
    groupTitle: candidate.groupTitle,
    groupOrder: candidate.groupOrder,
    pagePosition: `${Math.round(image.getBoundingClientRect().left)},${Math.round(image.getBoundingClientRect().top)}`,
    naturalWidth: image.naturalWidth || 0,
    naturalHeight: image.naturalHeight || 0,
    mimeType: image.naturalWidth ? "image/jpeg" : null,
    sizeBytes: null,
    dataUrl: null,
    collectionError: src ? null : "图片地址为空",
  };
};

const readImageAsset = async (candidate: ImageSelection): Promise<PageImage> => {
  const imageAsset = imageAssetMetadata(candidate);
  const src = imageAsset.src;
  if (!src) return imageAsset;
  try {
    if (src.startsWith("blob:") || src.startsWith("data:")) {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const normalizedBlob = await ReviewImageNormalization.normalizeBlob(blob);
      imageAsset.mimeType = normalizedBlob.type;
      imageAsset.sizeBytes = normalizedBlob.size;
      imageAsset.dataUrl = await blobToDataUrl(normalizedBlob);
    } else {
      const result = await chrome.runtime.sendMessage({ type: "FETCH_IMAGE_ASSET", url: src });
      if (!result?.ok) throw new Error(result?.error || "后台图片读取失败");
      imageAsset.mimeType = result.mimeType;
      imageAsset.sizeBytes = result.sizeBytes;
      imageAsset.dataUrl = result.dataUrl;
    }
  } catch (error) {
    imageAsset.collectionError = error instanceof Error ? error.message : "图片读取失败";
  }
  return imageAsset;
};
const SCRAP_WRITABLE_FIELDS = new Set([
  "old_vehicle.recycle_date", "scrap_certificate.certificate_no", "old_vehicle.vin", "old_vehicle.plate_no", "old_vehicle.owner", "old_vehicle.engine_model",
  "invoice.code", "invoice.invoice_no", "invoice.amount", "invoice.invoice_date", "new_vehicle.vin", "new_vehicle.plate_no", "new_vehicle.owner",
  "page_ocr.new_vehicle_vin", "application.customer_name",
  "old_vehicle.type", "new_vehicle.fuel_type", "new_vehicle.registration_date",
  "application.terminal_phone", "application.terminal_certificate_no", "application.owner_type",
  "old_vehicle.affiliation", "new_vehicle.affiliation",
]);

const controlFields = (collection: CollectionSnapshot) => {
  const fields = { ...collection.pageFields };
  for (const { field, element } of collection.fieldTargets || []) {
    const snapshot = ReviewPageFieldWriter?.captureValue?.(element as HTMLElement);
    if (snapshot) fields[field] = snapshot.value;
  }
  return fields;
};

const sameCollectedRecord = (message: ReviewMessage) => {
  const currentFields = controlFields(ReviewPageFieldCollector.collect(document, null));
  for (const [field, write] of verifiedFieldWrites) {
    if (currentFields[field] === write.value) currentFields[field] = write.original;
  }
  return (
    message.expectedPageUrl === window.location.href &&
    message.expectedPageInstanceId === pageInstanceId &&
    Boolean(message.expectedPageFingerprint) &&
    message.expectedPageFingerprint === pageFingerprint(currentFields)
  );
};

const sameActiveCollection = (message: ReviewMessage) =>
  Boolean(message.expectedCollectionId) && message.expectedCollectionId === activeCollectionId;

const sameReviewIdentity = (message: ReviewMessage) => sameCollectedRecord(message) && sameActiveCollection(message);
// The target field may have been normalized by a framework after collection;
// identity remains valid when every anchor except that field is unchanged.
const sameReviewIdentityExceptFields = (message: ReviewMessage, fields: string[]) => {
  if (sameReviewIdentity(message)) return true;
  if (message.expectedPageUrl !== window.location.href || message.expectedPageInstanceId !== pageInstanceId || message.expectedCollectionId !== activeCollectionId) return false;
  const current = controlFields(ReviewPageFieldCollector.collect(document, null));
  const expected: Array<[string, unknown]> = JSON.parse(message.expectedPageFingerprint || "[]");
  const expectedMap = new Map<string, unknown>(expected);
  const actual: Array<[string, unknown]> = JSON.parse(pageFingerprint(current) || "[]");
  const actualMap = new Map<string, unknown>(actual);
  let stableAnchor = false;
  for (const [anchor, value] of expectedMap) {
    if (fields.includes(anchor)) continue;
    // Some framework controls are temporarily absent while a form item
    // rerenders. Only reject a write when a comparable anchor is present and
    // has actually changed; the target field itself is allowed to differ.
    if (!actualMap.has(anchor)) continue;
    if (String(actualMap.get(anchor) ?? "") !== String(value ?? "")) return false;
    stableAnchor = true;
  }
  return stableAnchor || expectedMap.size === 1;
};

const sameReviewIdentityExceptField = (message: ReviewMessage, field: string) => sameReviewIdentityExceptFields(message, [field]);

const focusReviewImage = (message: ReviewMessage) => {
  if (!sameCollectedRecord(message) || !message.expectedCollectionId || message.expectedCollectionId !== activeCollectionId) {
    return { ok: false, error: "页面已变化，请重新采集" };
  }
  const snapshot = reviewImageElements.get(message.imageId);
  const image = snapshot?.image;
  if (!image?.isConnected || (image.currentSrc || image.src) !== snapshot.src) {
    return { ok: false, error: "原图已变化，请重新采集" };
  }
  return ReviewImageFocus.focus(image);
};

const isCollectionMessage = (message: ReviewMessage) =>
  message?.type === MESSAGE_TYPES.collectPageData
  || message?.type === MESSAGE_TYPES.collectPageManifest;

chrome.runtime.onMessage.addListener((message: ReviewMessage, _sender, sendResponse) => {
  if (message.type === MESSAGE_TYPES.readReviewImage) {
    const entry = message.imageId ? reviewImageCandidates.get(message.imageId) : null;
    if (!entry || entry.collectionId !== activeCollectionId || message.expectedCollectionId !== activeCollectionId) {
      sendResponse({ ok: false, error: "图片采集批次已失效，请重新审核" });
      return true;
    }
    if (!entry.candidate.image.isConnected) {
      sendResponse({ ok: false, error: "原图已离开页面，请重新审核" });
      return true;
    }
    readImageAsset(entry.candidate)
      .then((image) => sendResponse({ ok: true, image }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "图片读取失败" }));
    return true;
  }
  if (message.type === MESSAGE_TYPES.verifyInvoice) {
    if (!sameReviewIdentity(message)) {
      sendResponse({ ok: false, message: "页面已变化，请重新审核" });
      return true;
    }
    sendResponse(ReviewPageFieldWriter.triggerInvoiceVerification(document));
    return;
  }
  if (message.type === MESSAGE_TYPES.applyPageFieldValue) {
    const action = message.action;
    if (!action?.field || typeof action.value !== "string") {
      sendResponse({ ok: false, message: "字段回填参数不完整", actions: [] });
      return true;
    }
    if (!sameReviewIdentityExceptField(message, action.field)) {
      sendResponse({ ok: false, code: "PAGE_IDENTITY_CHANGED", message: "页面已变化，请重新审核", actions: [] });
      return true;
    }
    if (!SCRAP_WRITABLE_FIELDS.has(action.field)) {
      sendResponse({ ok: false, message: "该字段不在报废置换允许回填范围内", actions: [] });
      return true;
    }
    const entry = reviewFieldElements.get(action.field);
    if (!entry?.element || entry.collectionId !== activeCollectionId) {
      sendResponse({ ok: false, message: "未找到该字段的当前页面控件", actions: [] });
      return true;
    }
    // Bind expected values to the actual input captured with this collection,
    // not wrapper text displayed beside it (validation badges/overlays).
    const writeAction = { ...action, field: action.field, value: action.value };
    if (entry.controlSnapshot && writeAction.expectedValue === entry.collectedValue) {
      writeAction.expectedValue = entry.controlSnapshot.value;
    }
    if (entry.controlSnapshot && ReviewPageFieldWriter.captureValue(entry.element)?.control !== entry.controlSnapshot.control) {
      sendResponse({ ok: false, code: "FIELD_TARGET_CHANGED", message: "该字段控件已重新加载，请重新采集后回填", actions: [] });
      return true;
    }
    const writeGuard = () => {
      if (sameReviewIdentity(message)) return true;
      // A successful write legitimately changes the target field used by the
      // page fingerprint. Validate all other anchors and the expected value,
      // while substituting the value we just wrote for that one field.
      const currentFields = controlFields(ReviewPageFieldCollector.collect(document, null));
      if (String(currentFields[action.field!] ?? "").trim() !== action.value!.trim()) return false;
      const expectedFields = { ...currentFields };
      for (const [field, write] of verifiedFieldWrites) {
        if (expectedFields[field] === write.value) expectedFields[field] = write.original;
      }
      expectedFields[action.field!] = verifiedFieldWrites.get(action.field!)?.original ?? action.expectedValue;
      return message.expectedPageUrl === window.location.href
        && message.expectedPageInstanceId === pageInstanceId
        && message.expectedCollectionId === activeCollectionId
        && message.expectedPageFingerprint === pageFingerprint(expectedFields);
    };
    ReviewPageFieldWriter.executeValue(document, entry.element, writeAction, writeGuard)
      .then((result) => {
        if (result.ok) verifiedFieldWrites.set(action.field, {
          original: verifiedFieldWrites.get(action.field)?.original ?? action.expectedValue,
          value: result.actions?.[0]?.value ?? action.value,
        });
        if (result.ok || result.code === "FIELD_VALUE_CHANGED") {
          entry.controlSnapshot = ReviewPageFieldWriter.captureValue(entry.element);
          entry.collectedValue = result.ok ? result.actions?.[0]?.value : result.currentValue;
        }
        sendResponse(result);
      })
      .catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "字段回填失败", actions: [] }));
    return true;
  }
  if (message.type === MESSAGE_TYPES.applyPageFieldGroupValue) {
    const action = message.action as PageWriteGroupAction | undefined;
    const fields = action?.fields || [];
    if (!action || fields.length < 2 || new Set(fields).size !== fields.length || typeof action.value !== "string") {
      sendResponse({ ok: false, message: "组合字段回填参数不完整", actions: [] });
      return true;
    }
    if (!sameReviewIdentityExceptFields(message, fields)) {
      sendResponse({ ok: false, code: "PAGE_IDENTITY_CHANGED", message: "页面已变化，请重新审核", actions: [] });
      return true;
    }
    const entries = fields.map((field) => ({ field, entry: reviewFieldElements.get(field) })).map(({ field, entry }) => ({
      field,
      element: entry?.element,
      expectedValue: action.expectedValues?.[field] ?? entry?.collectedValue,
      entry,
    }));
    if (entries.some((item) => !item.element || item.entry?.collectionId !== activeCollectionId || !SCRAP_WRITABLE_FIELDS.has(item.field))) {
      sendResponse({ ok: false, message: "未找到组合字段的当前页面控件或字段不在允许范围内", actions: [] });
      return true;
    }
    if (entries.some((item) => item.entry.controlSnapshot && ReviewPageFieldWriter.captureValue(item.element)?.control !== item.entry.controlSnapshot.control)) {
      sendResponse({ ok: false, code: "FIELD_TARGET_CHANGED", message: "组合字段控件已重新加载，请重新采集后回填", actions: [] });
      return true;
    }
    ReviewPageFieldWriter.executeValueGroup(
      document,
      entries.map((item) => ({ field: item.field, element: item.element, expectedValue: item.expectedValue })),
      action,
      () => sameReviewIdentityExceptFields(message, fields),
    ).then((result) => {
      if (result.ok) {
        for (const item of entries) {
          const filled = result.actions?.find((candidate) => candidate.field === item.field);
          if (filled) {
            verifiedFieldWrites.set(item.field, {
              original: item.expectedValue,
              value: filled.value,
            });
            item.entry.controlSnapshot = ReviewPageFieldWriter.captureValue(item.element);
            item.entry.collectedValue = filled.value;
          }
        }
      }
      sendResponse(result);
    }).catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "组合字段回填失败", actions: [] }));
    return true;
  }
  if (message.type === MESSAGE_TYPES.applyPageFillIntent) {
    if (!sameReviewIdentity(message)) {
      sendResponse({ ok: false, message: "页面已变化，请重新审核", actions: [] });
      return true;
    }
    ReviewPageFieldWriter.execute(document, (message.actions || []) as PageFillAction[], () => sameReviewIdentity(message))
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "挂靠字段填写失败",
        actions: [],
      }));
    return true;
  }
  if (message.type === MESSAGE_TYPES.focusReviewImage) {
    sendResponse(focusReviewImage(message));
    return;
  }
  if (!isCollectionMessage(message)) {
    return;
  }

  const collectionId = nextCollectionId();
  latestCollectionId = collectionId;

  const log = (event: string, details: Record<string, unknown> = {}) => {
    console.info("[ReviewAgent][collect]", event, details);
  };
  log("start", { url: window.location.href, title: document.title });

  const allText = document.body.innerText || "";
  const businessResolution = ReviewBusinessDetector.resolve(
    window.location.href,
    allText,
    message.businessSelection as BusinessSelection | null | undefined,
  );
  const business = businessResolution.business;
  const fieldCollection = ReviewPageFieldCollector.collect(
    document,
    business?.businessType ?? null,
  );
  const pageFields = controlFields(fieldCollection);
  const controlSnapshots = new Map(fieldCollection.fieldTargets.map(({ field, element }) =>
    [field, ReviewPageFieldWriter?.captureValue?.(element) ?? null]));
  const reviewFields = (fieldCollection.reviewFields || []).map((item) =>
    item.field && controlSnapshots.get(item.field) ? { ...item, value: pageFields[item.field] } : item);
  const writableTargets = fieldCollection.writableTargets;
  const unmatchedLabels = fieldCollection.unmatchedLabels;
  // DOM 元素只保留在 Content Script 内部；跨消息只发送字段键和可定位状态。
  const fieldTargets = fieldCollection.fieldTargets.map(({ field }) => ({
    field,
    present: true,
  }));
  log("fields", {
    scannedControls: fieldCollection.scannedControls,
    matchedFields: Object.keys(pageFields).length,
    reviewFieldCount: reviewFields.length,
    unmatchedLabels,
    candidateCount: fieldCollection.candidateCount,
    ambiguousFields: fieldCollection.ambiguousFields
  });

  const pageImages = Array.from(document.images);
  const imageIndexes = new Map(pageImages.map((image, index) => [image, index]));
  const scopeItems: Array<{ kind: "label"; text: string } | { kind: "image"; index: number }> = []
  document.body.querySelectorAll("*").forEach((element) => {
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .trim();
    if (ReviewBusinessScope.scopeForLabel(directText)) {
      scopeItems.push({ kind: "label", text: directText });
    }
    if (element instanceof HTMLImageElement) {
      const index = imageIndexes.get(element);
      if (index != null) scopeItems.push({ kind: "image", index });
    }
  });
  const scopeByIndex = new Map(
    ReviewBusinessScope.assign(scopeItems).map((item) => [item.index, item])
  );

  const imageCandidates = pageImages.map((image, index) => {
    const rect = image.getBoundingClientRect();
    const style = window.getComputedStyle(image);
    const hint = image.closest("section, article, li, div")?.textContent?.slice(0, 160) || image.alt || "";
    const ownHint = [image.alt, image.title, image.getAttribute("aria-label")]
      .filter(Boolean)
      .join(" ");
    const parent = image.parentElement;
    const emptySlot = /暂无图片|尚未上传|未上传图片/.test(ownHint)
      || Boolean(
        parent
        && parent.querySelectorAll("img").length === 1
        && /暂无图片|尚未上传|未上传图片/.test(parent.textContent || ""),
      );
    const scope = scopeByIndex.get(index) || {
      businessScope: "unknown",
      groupTitle: "未分类资料",
      groupOrder: index + 1,
      imageId: `unknown-${String(index + 1).padStart(2, "0")}`,
    };
    return {
      image,
      index,
      ...scope,
      src: image.currentSrc || image.src,
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      naturalWidth: image.naturalWidth || 0,
      naturalHeight: image.naturalHeight || 0,
      className: typeof image.className === "string" ? image.className : "",
      role: image.getAttribute("role") || "",
      ariaHidden: image.getAttribute("aria-hidden") === "true",
      emptySlot,
      hint,
      categoryHint: classifyImage(hint)
    };
  });
  const selection = ReviewImageCandidates.select(imageCandidates, MAX_REVIEW_IMAGES);
  const images = selection.selected;
  const imageAssetsPromise = message.type === MESSAGE_TYPES.collectPageManifest
    ? Promise.resolve(images.map(imageAssetMetadata))
    : Promise.all(images.map((candidate) => readImageAsset(candidate)));
  imageAssetsPromise
    .then((imageAssets) => {
      if (latestCollectionId !== collectionId) {
        // 被取代的采集也要带回业务识别结果和真实原因，面板不得退化为“无法识别业务”。
        sendResponse({
          ...(business || {}),
          pageUrl: window.location.href,
          pageInstanceId,
          pageFingerprint: pageFingerprint(pageFields),
          collectionId,
          pageFields,
          reviewFields,
          images: [],
          staleCollection: true,
          businessDetectionError: businessResolution.error,
          collectionIssues: ["页面采集已过期，请重新采集"],
          collectionDiagnostics: { imageSuccessCount: 0, imageFailureCount: 0 },
        });
        return;
      }
      // The active map changes only with the response that owns this token.
      reviewImageElements.clear();
      reviewImageCandidates.clear();
      images.forEach((candidate, index) => {
        const imageAsset = imageAssets[index];
        if (imageAsset?.src) reviewImageElements.set(candidate.imageId, { image: candidate.image, src: imageAsset.src });
        if (candidate.imageId) reviewImageCandidates.set(candidate.imageId, { collectionId, candidate });
      });
      reviewFieldElements.clear();
      verifiedFieldWrites.clear();
      for (const { field, element } of fieldCollection.fieldTargets) {
        reviewFieldElements.set(field, { element, collectionId, collectedValue: pageFields[field] ?? null,
          controlSnapshot: controlSnapshots.get(field) ?? null });
      }
      activeCollectionId = collectionId;
      const imageFailureCount = imageAssets.filter((image) => image.collectionError).length;
      const collectionDiagnostics = {
        scannedControls: fieldCollection.scannedControls,
        matchedFields: Object.keys(pageFields).length,
        reviewFieldCount: reviewFields.length,
        unmatchedLabels,
        candidateCount: fieldCollection.candidateCount,
        ambiguousFields: fieldCollection.ambiguousFields,
        imageSuccessCount: imageAssets.length - imageFailureCount,
        imageFailureCount,
        scannedImages: selection.scannedCount,
        selectedImages: imageAssets.length,
        imageOverflow: selection.overflow,
        collectionIssues: selection.overflow
          ? [`候选资料超过 ${MAX_REVIEW_IMAGES} 张，请确认是否漏审`]
          : []
      };
      log("complete", {
        imageCount: imageAssets.length,
        imageFailureCount,
        fieldCount: Object.keys(pageFields).length,
        scannedImages: selection.scannedCount,
        selectedImages: imageAssets.length,
        imageOverflow: selection.overflow
      });
      sendResponse({
      ...(business || {}),
      pageUrl: window.location.href,
      pageInstanceId,
      pageFingerprint: pageFingerprint(pageFields),
      collectionId,
      pageTitle: document.title,
      pageFields,
      reviewFields,
      writableTargets,
      fieldTargets,
      pageText: allText,
      images: imageAssets,
      businessDetectionError: businessResolution.error,
      collectionIssues: selection.overflow
        ? [`候选资料超过 ${MAX_REVIEW_IMAGES} 张，请确认是否漏审`]
        : [],
      collectionDiagnostics
      });
    })
    .catch((error) => {
      log("failed", { message: error instanceof Error ? error.message : "unknown" });
      sendResponse({
      ...(business || {}),
      pageUrl: window.location.href,
      pageInstanceId,
      pageFingerprint: pageFingerprint(pageFields),
      collectionId,
      pageTitle: document.title,
      pageFields,
      reviewFields,
      writableTargets,
      fieldTargets,
      pageText: allText,
      images: [],
      businessDetectionError: businessResolution.error,
      collectionIssues: [error instanceof Error ? error.message : "图片采集失败"],
      collectionDiagnostics: {
        scannedControls: fieldCollection.scannedControls,
        matchedFields: Object.keys(pageFields).length,
        reviewFieldCount: reviewFields.length,
        unmatchedLabels,
        candidateCount: fieldCollection.candidateCount,
        ambiguousFields: fieldCollection.ambiguousFields,
        imageSuccessCount: 0,
        imageFailureCount: 0
      }
      });
    });
  return true;
});
