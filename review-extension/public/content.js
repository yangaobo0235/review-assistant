/**
 * 功能：协调页面采集、图片标准化和原图定位消息。
 * 职责边界：复杂识别逻辑委托给独立公共脚本；DOM 元素不跨消息传输。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

// Keep collection orchestration here; field, image, normalization, and focus rules live in dedicated scripts.
const reviewImageElements = new Map();
const reviewFieldElements = new Map();
const verifiedFieldWrites = new Map();
const MAX_REVIEW_IMAGES = 16;
const pageInstanceId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
let activeCollectionId = "";
let latestCollectionId = "";
let collectionSequence = 0;
const nextCollectionId = () => `${pageInstanceId}:${++collectionSequence}`;
const pageFingerprint = (fields) => {
  const anchors = ["application.id", "old_vehicle.vin", "new_vehicle.vin", "old_vehicle.owner", "new_vehicle.owner"]
    .map((field) => [field, String(fields?.[field] || "").trim()])
    .filter(([, value]) => value);
  const hasStrongAnchor = anchors.some(([field]) => field === "application.id" || field.endsWith(".vin"));
  return hasStrongAnchor ? JSON.stringify(anchors) : "";
};
const MESSAGE_TYPES = Object.freeze({
  collectPageData: "COLLECT_PAGE_DATA",
  focusReviewImage: "FOCUS_REVIEW_IMAGE",
  applyPageFillIntent: "APPLY_PAGE_FILL_INTENT",
  applyPageFieldValue: "APPLY_PAGE_FIELD_VALUE",
  verifyInvoice: "VERIFY_INVOICE",
});
const SCRAP_WRITABLE_FIELDS = new Set([
  "old_vehicle.recycle_date", "scrap_certificate.certificate_no", "old_vehicle.vin", "old_vehicle.plate_no", "old_vehicle.owner", "old_vehicle.engine_model",
  "invoice.code", "invoice.invoice_no", "invoice.amount", "invoice.invoice_date", "new_vehicle.vin", "new_vehicle.plate_no", "new_vehicle.owner",
  "page_ocr.new_vehicle_vin", "application.customer_name",
  "old_vehicle.type", "new_vehicle.fuel_type", "new_vehicle.registration_date",
  "application.terminal_phone", "application.terminal_certificate_no", "application.owner_type",
  "old_vehicle.affiliation", "new_vehicle.affiliation",
]);

const controlFields = (collection) => {
  const fields = { ...collection.pageFields };
  for (const { field, element } of collection.fieldTargets || []) {
    const snapshot = globalThis.ReviewPageFieldWriter?.captureValue?.(element);
    if (snapshot) fields[field] = snapshot.value;
  }
  return fields;
};

const sameCollectedRecord = (message) => {
  const currentFields = controlFields(globalThis.ReviewPageFieldCollector.collect(document, null));
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

const sameActiveCollection = (message) =>
  Boolean(message.expectedCollectionId) && message.expectedCollectionId === activeCollectionId;

const sameReviewIdentity = (message) => sameCollectedRecord(message) && sameActiveCollection(message);
// The target field may have been normalized by a framework after collection;
// identity remains valid when every anchor except that field is unchanged.
const sameReviewIdentityExceptField = (message, field) => {
  if (sameReviewIdentity(message)) return true;
  if (message.expectedPageUrl !== window.location.href || message.expectedPageInstanceId !== pageInstanceId || message.expectedCollectionId !== activeCollectionId) return false;
  const current = controlFields(globalThis.ReviewPageFieldCollector.collect(document, null));
  const expected = JSON.parse(message.expectedPageFingerprint || "[]");
  const expectedMap = new Map(expected);
  const actual = JSON.parse(pageFingerprint(current) || "[]");
  const actualMap = new Map(actual);
  let stableAnchor = false;
  for (const [anchor, value] of expectedMap) {
    if (anchor === field) continue;
    // Some framework controls are temporarily absent while a form item
    // rerenders. Only reject a write when a comparable anchor is present and
    // has actually changed; the target field itself is allowed to differ.
    if (!actualMap.has(anchor)) continue;
    if (String(actualMap.get(anchor) ?? "") !== String(value ?? "")) return false;
    stableAnchor = true;
  }
  return stableAnchor || expectedMap.size === 1;
};

const focusReviewImage = (message) => {
  if (!sameCollectedRecord(message) || !message.expectedCollectionId || message.expectedCollectionId !== activeCollectionId) {
    return { ok: false, error: "页面已变化，请重新采集" };
  }
  const snapshot = reviewImageElements.get(message.imageId);
  const image = snapshot?.image;
  if (!image?.isConnected || (image.currentSrc || image.src) !== snapshot.src) {
    return { ok: false, error: "原图已变化，请重新采集" };
  }
  return globalThis.ReviewImageFocus.focus(image);
};

const isCollectionMessage = (message) =>
  message?.type === MESSAGE_TYPES.collectPageData;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MESSAGE_TYPES.verifyInvoice) {
    if (!sameReviewIdentity(message)) {
      sendResponse({ ok: false, message: "页面已变化，请重新审核" });
      return true;
    }
    sendResponse(globalThis.ReviewPageFieldWriter.triggerInvoiceVerification(document));
    return;
  }
  if (message.type === MESSAGE_TYPES.applyPageFieldValue) {
    if (!sameReviewIdentityExceptField(message, message.action?.field)) {
      sendResponse({ ok: false, code: "PAGE_IDENTITY_CHANGED", message: "页面已变化，请重新审核", actions: [] });
      return true;
    }
    if (!SCRAP_WRITABLE_FIELDS.has(message.action?.field)) {
      sendResponse({ ok: false, message: "该字段不在报废置换允许回填范围内", actions: [] });
      return true;
    }
    const entry = reviewFieldElements.get(message.action?.field);
    if (!entry?.element || entry.collectionId !== activeCollectionId) {
      sendResponse({ ok: false, message: "未找到该字段的当前页面控件", actions: [] });
      return true;
    }
    // Bind expected values to the actual input captured with this collection,
    // not wrapper text displayed beside it (validation badges/overlays).
    const action = { ...message.action };
    if (entry.controlSnapshot && action.expectedValue === entry.collectedValue) {
      action.expectedValue = entry.controlSnapshot.value;
    }
    if (entry.controlSnapshot && globalThis.ReviewPageFieldWriter.captureValue(entry.element)?.control !== entry.controlSnapshot.control) {
      sendResponse({ ok: false, code: "FIELD_TARGET_CHANGED", message: "该字段控件已重新加载，请重新采集后回填", actions: [] });
      return true;
    }
    const writeGuard = () => {
      if (sameReviewIdentity(message)) return true;
      // A successful write legitimately changes the target field used by the
      // page fingerprint. Validate all other anchors and the expected value,
      // while substituting the value we just wrote for that one field.
      const currentFields = controlFields(globalThis.ReviewPageFieldCollector.collect(document, null));
      if (String(currentFields[message.action.field] ?? "").trim() !== message.action.value.trim()) return false;
      const expectedFields = { ...currentFields };
      for (const [field, write] of verifiedFieldWrites) {
        if (expectedFields[field] === write.value) expectedFields[field] = write.original;
      }
      expectedFields[message.action.field] = verifiedFieldWrites.get(message.action.field)?.original ?? message.action.expectedValue;
      return message.expectedPageUrl === window.location.href
        && message.expectedPageInstanceId === pageInstanceId
        && message.expectedCollectionId === activeCollectionId
        && message.expectedPageFingerprint === pageFingerprint(expectedFields);
    };
    globalThis.ReviewPageFieldWriter.executeValue(document, entry.element, action, writeGuard)
      .then((result) => {
        if (result.ok) verifiedFieldWrites.set(message.action.field, {
          original: verifiedFieldWrites.get(message.action.field)?.original ?? message.action.expectedValue,
          value: result.actions?.[0]?.value ?? message.action.value,
        });
        if (result.ok || result.code === "FIELD_VALUE_CHANGED") {
          entry.controlSnapshot = globalThis.ReviewPageFieldWriter.captureValue(entry.element);
          entry.collectedValue = result.ok ? result.actions?.[0]?.value : result.currentValue;
        }
        sendResponse(result);
      })
      .catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "字段回填失败", actions: [] }));
    return true;
  }
  if (message.type === MESSAGE_TYPES.applyPageFillIntent) {
    if (!sameReviewIdentity(message)) {
      sendResponse({ ok: false, message: "页面已变化，请重新审核", actions: [] });
      return true;
    }
    globalThis.ReviewPageFieldWriter.execute(document, message.actions, () => sameReviewIdentity(message))
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

  const log = (event, details = {}) => {
    console.info("[ReviewAgent][collect]", event, details);
  };
  log("start", { url: window.location.href, title: document.title });

  const allText = document.body.innerText || "";
  const businessResolution = globalThis.ReviewBusinessDetector.resolve(
    window.location.href,
    allText,
    message.businessSelection,
  );
  const business = businessResolution.business;
  const fieldCollection = globalThis.ReviewPageFieldCollector.collect(
    document,
    business?.businessType ?? null,
  );
  const pageFields = controlFields(fieldCollection);
  const controlSnapshots = new Map(fieldCollection.fieldTargets.map(({ field, element }) =>
    [field, globalThis.ReviewPageFieldWriter?.captureValue?.(element) ?? null]));
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

  // 图片分组是启发式信息，最终文档类型仍由 OCR/多模态工具确认。
  const classifyImage = (hint) => {
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

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片转换失败"));
    reader.readAsDataURL(blob);
  });

  const readImageAsset = async (candidate) => {
    const { image, index } = candidate;
    const src = image.currentSrc || image.src;
    const hint = image.closest("section, article, li, div")?.textContent?.slice(0, 160) || image.alt || "";
    const imageAsset = {
      imageId: candidate.imageId,
      index,
      src,
      alt: image.alt || "",
      group: hint.slice(0, 80) || "未分类",
      categoryHint: classifyImage(hint),
      documentTypeHint: globalThis.ReviewBusinessScope.documentTypeFor?.(
        candidate.businessScope,
        candidate.groupOrder,
        candidate.categoryHint,
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
      collectionError: null
    };
    if (!src) {
      imageAsset.collectionError = "图片地址为空";
      return imageAsset;
    }
    try {
      if (src.startsWith("blob:") || src.startsWith("data:")) {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const normalizedBlob = await globalThis.ReviewImageNormalization.normalizeBlob(blob);
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

  const pageImages = Array.from(document.images);
  const imageIndexes = new Map(pageImages.map((image, index) => [image, index]));
  const scopeItems = [];
  document.body.querySelectorAll("*").forEach((element) => {
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .trim();
    if (globalThis.ReviewBusinessScope.scopeForLabel(directText)) {
      scopeItems.push({ kind: "label", text: directText });
    }
    if (element instanceof HTMLImageElement) {
      scopeItems.push({ kind: "image", index: imageIndexes.get(element) });
    }
  });
  const scopeByIndex = new Map(
    globalThis.ReviewBusinessScope.assign(scopeItems).map((item) => [item.index, item])
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
  const selection = globalThis.ReviewImageCandidates.select(imageCandidates, MAX_REVIEW_IMAGES);
  const images = selection.selected;
  Promise.all(images.map((candidate) => readImageAsset(candidate)))
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
      images.forEach((candidate, index) => {
        const imageAsset = imageAssets[index];
        if (imageAsset?.src) reviewImageElements.set(candidate.imageId, { image: candidate.image, src: imageAsset.src });
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
