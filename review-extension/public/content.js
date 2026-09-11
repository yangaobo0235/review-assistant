/**
 * 功能：协调页面采集、图片标准化和原图定位消息。
 * 职责边界：复杂识别逻辑委托给独立公共脚本；DOM 元素不跨消息传输。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

// Keep collection orchestration here; field, image, normalization, and focus rules live in dedicated scripts.
const reviewImageElements = new Map();
const reviewFieldElements = new Map();
const MAX_REVIEW_IMAGES = 10;
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
  showReviewFieldStep: "SHOW_REVIEW_FIELD_STEP",
  completeReviewFieldStep: "COMPLETE_REVIEW_FIELD_STEP",
  clearReviewFieldMarkers: "CLEAR_REVIEW_FIELD_MARKERS",
  reviewFieldDecision: "REVIEW_FIELD_DECISION",
});
// 人工选择只有两种；其他值一律不转发给审核助手。
const REVIEWER_DECISIONS = Object.freeze(["CONFIRMED", "MARKED_EXCEPTION"]);
const REVIEW_IDENTITY_ERROR = "页面已变化，请重新审核";
const REVIEW_TARGET_ERROR = "页面字段已变化，请重新审核";

const sameCollectedRecord = (message) => {
  const currentFields = globalThis.ReviewPageFieldCollector.collect(document, null).pageFields;
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

const reportFieldDecision = (step, decision) => {
  if (!REVIEWER_DECISIONS.includes(decision)) return false;
  const sent = chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.reviewFieldDecision,
    stepId: step.step_id,
    decision,
    pageInstanceId,
    collectionId: activeCollectionId,
  });
  if (typeof sent?.catch === "function") sent.catch(() => {});
  return true;
};

// 标记只使用采集时登记的唯一目标；映射过期、元素脱离 DOM 或身份不符时立即拒绝，不做模糊重找。
const showReviewFieldStep = (message) => {
  if (!sameReviewIdentity(message)) return { ok: false, error: REVIEW_IDENTITY_ERROR };
  const step = message.step;
  const field = step?.page_field;
  if (!field) return { ok: false, error: "审核步骤未指定页面字段" };
  const entry = reviewFieldElements.get(field);
  if (!entry || entry.collectionId !== activeCollectionId || !entry.element?.isConnected) {
    return { ok: false, error: REVIEW_TARGET_ERROR };
  }
  let reported = false;
  return globalThis.ReviewPageMarker.show(entry.element, step, (decision) => {
    if (reported) return;
    reported = reportFieldDecision(step, decision);
  });
};

const completeReviewFieldStep = (message) => {
  if (!sameReviewIdentity(message)) return { ok: false, error: REVIEW_IDENTITY_ERROR };
  const stepId = message.stepId || message.step?.step_id;
  if (!stepId) return { ok: false, error: "审核步骤缺少标识" };
  return globalThis.ReviewPageMarker.complete(stepId, message.decision);
};

const clearReviewFieldMarkers = (message) => {
  if (!sameReviewIdentity(message)) return { ok: false, error: REVIEW_IDENTITY_ERROR };
  globalThis.ReviewPageMarker.clear();
  return { ok: true };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MESSAGE_TYPES.applyPageFillIntent) {
    if (!sameCollectedRecord(message)) {
      sendResponse({ ok: false, message: "页面已变化，请重新审核", actions: [] });
      return true;
    }
    globalThis.ReviewPageFieldWriter.execute(document, message.actions, () => sameCollectedRecord(message))
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
  if (message.type === MESSAGE_TYPES.showReviewFieldStep) {
    sendResponse(showReviewFieldStep(message));
    return;
  }
  if (message.type === MESSAGE_TYPES.completeReviewFieldStep) {
    sendResponse(completeReviewFieldStep(message));
    return;
  }
  if (message.type === MESSAGE_TYPES.clearReviewFieldMarkers) {
    sendResponse(clearReviewFieldMarkers(message));
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
  const pageFields = fieldCollection.pageFields;
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
    if (text.includes("报废车辆资料") || text.includes("旧车资料")) return "old_vehicle";
    if (text.includes("新车资料")) return "new_vehicle";
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
      documentTypeHint: candidate.categoryHint,
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
      hint,
      categoryHint: classifyImage(hint)
    };
  });
  const selection = globalThis.ReviewImageCandidates.select(imageCandidates, MAX_REVIEW_IMAGES);
  const images = selection.selected;
  Promise.all(images.map((candidate) => readImageAsset(candidate)))
    .then((imageAssets) => {
      if (latestCollectionId !== collectionId) {
        sendResponse({
          pageUrl: window.location.href,
          pageInstanceId,
          pageFingerprint: pageFingerprint(pageFields),
          collectionId,
          pageFields,
          images: [],
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
      for (const { field, element } of fieldCollection.fieldTargets) {
        reviewFieldElements.set(field, { element, collectionId });
      }
      // 新采集生效即代表旧标记失效；只清理扩展自己创建的节点，不触碰宿主控件。
      globalThis.ReviewPageMarker?.clear?.();
      activeCollectionId = collectionId;
      const imageFailureCount = imageAssets.filter((image) => image.collectionError).length;
      const collectionDiagnostics = {
        scannedControls: fieldCollection.scannedControls,
        matchedFields: Object.keys(pageFields).length,
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
      writableTargets,
      fieldTargets,
      pageText: allText,
      images: [],
      businessDetectionError: businessResolution.error,
      collectionIssues: [error instanceof Error ? error.message : "图片采集失败"],
      collectionDiagnostics: {
        scannedControls: fieldCollection.scannedControls,
        matchedFields: Object.keys(pageFields).length,
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
