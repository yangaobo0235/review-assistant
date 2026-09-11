import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
);
const contentSource = readFileSync(
  new URL("../public/content.js", import.meta.url),
  "utf8",
);

test("loads the page field collector before the content script", () => {
  const scripts = manifest.content_scripts[0].js;

  assert.ok(scripts.indexOf("page-field-collector.js") >= 0);
  assert.ok(
    scripts.indexOf("page-field-collector.js") < scripts.indexOf("content.js"),
  );
});

test("loads the review marker before the content script and keeps the other scripts in order", () => {
  const scripts = manifest.content_scripts[0].js;

  assert.ok(scripts.indexOf("page-review-marker.js") >= 0);
  assert.ok(scripts.indexOf("page-review-marker.js") < scripts.indexOf("content.js"));
  assert.ok(scripts.indexOf("page-field-collector.js") < scripts.indexOf("page-review-marker.js"));
  assert.ok(scripts.indexOf("page-field-writer.js") < scripts.indexOf("page-review-marker.js"));
  assert.deepEqual(scripts.filter((script) => script !== "page-review-marker.js"), [
    "business-detector.js",
    "page-field-collector.js",
    "field-matcher.js",
    "business-scope.js",
    "image-candidates.js",
    "image-focus.js",
    "image-normalization.js",
    "page-field-writer.js",
    "content.js",
  ]);
});

test("content script delegates page field collection without requiring a detected business", () => {
  assert.match(
    contentSource,
    /ReviewPageFieldCollector\.collect\(\s*document,\s*business\?\.businessType \?\? null,?\s*\)/,
  );
  assert.doesNotMatch(contentSource, /business\.businessType/);
});

test("content script names its collection and focus message contract", () => {
  assert.match(contentSource, /const MESSAGE_TYPES = Object\.freeze/);
  assert.match(contentSource, /focusReviewImage/);
  assert.match(contentSource, /isCollectionMessage/);
  assert.match(contentSource, /collectPageData:\s*"COLLECT_PAGE_DATA"/);
  assert.match(contentSource, /focusReviewImage:\s*"FOCUS_REVIEW_IMAGE"/);
});

test("content script reports candidate and ambiguity diagnostics", () => {
  assert.match(contentSource, /candidateCount: fieldCollection\.candidateCount/);
  assert.match(contentSource, /ambiguousFields: fieldCollection\.ambiguousFields/);
});

test("content script sends writable target snapshots", () => {
  assert.match(contentSource, /writableTargets/);
  assert.match(contentSource, /pageInstanceId/);
  assert.match(contentSource, /expectedPageInstanceId/);
  assert.match(contentSource, /APPLY_PAGE_FILL_INTENT/);
});

test("content script keeps field elements in a map replaced only by the active collection", () => {
  assert.match(contentSource, /const reviewFieldElements = new Map\(\);/);
  assert.match(contentSource, /reviewFieldElements\.set\(field, \{ element, collectionId \}\);/);
  const expiredGuard = contentSource.indexOf("latestCollectionId !== collectionId");
  const fieldMapReplace = contentSource.indexOf("reviewFieldElements.clear()");
  assert.ok(expiredGuard >= 0);
  assert.ok(fieldMapReplace > expiredGuard);
});

test("content script sends field target snapshots without DOM elements", async () => {
  let handler;
  const element = { isConnected: true };
  const fields = { "application.id": "case-a", "old_vehicle.vin": "OLD-A" };
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { handler = listener; } },
        sendMessage: async () => ({ ok: true }),
      },
    },
    document: {
      title: "审核页",
      images: [],
      body: { innerText: "", querySelectorAll() { return []; } },
    },
    window: {
      location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" },
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
    },
    console: { info() {} },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewBusinessDetector: { resolve() { return { business: { businessType: "scrap_replacement" } }; } },
      ReviewPageFieldCollector: {
        collect() { return { pageFields: fields, fieldTargets: [{ field: "old_vehicle.vin", element }], writableTargets: [], unmatchedLabels: [], scannedControls: 0, candidateCount: 0, ambiguousFields: [] }; },
      },
      ReviewBusinessScope: { scopeForLabel() { return null; }, assign() { return []; } },
      ReviewImageCandidates: { select() { return { selected: [], scannedCount: 0, overflow: false }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];

  handler({ type: "COLLECT_PAGE_DATA" }, null, (response) => responses.push(response));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The response crosses a vm realm boundary, so compare JSON instead of prototypes.
  assert.equal(
    JSON.stringify(responses[0]?.fieldTargets),
    JSON.stringify([{ field: "old_vehicle.vin", present: true }]),
  );
  assert.equal(Object.hasOwn(responses[0].fieldTargets[0], "element"), false);
});

test("content script rejects a mismatched page identity before calling the writer", async () => {
  let handler;
  let writes = 0;
  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { handler = listener; } } } },
    document: {},
    window: { location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?case=next" } },
    globalThis: {
      ReviewPageFieldWriter: { execute() { writes += 1; } },
      ReviewPageFieldCollector: { collect() { return { pageFields: {} }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];

  const asynchronous = handler({
    type: "APPLY_PAGE_FILL_INTENT",
    actions: [],
    expectedPageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?case=old",
    expectedPageInstanceId: "old-instance",
  }, null, (response) => responses.push(response));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asynchronous, true);
  assert.equal(writes, 0);
  assert.equal(responses[0]?.ok, false);
  assert.match(responses[0]?.message || "", /页面已变化|重新审核/);
});

test("content script rejects a same-URL SPA record change by page fingerprint", async () => {
  let handler;
  let writes = 0;
  const currentFields = { "application.id": "case-b", "old_vehicle.vin": "OLD-B" };
  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { handler = listener; } } } },
    document: {},
    window: { location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" } },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewPageFieldWriter: { execute() { writes += 1; return Promise.resolve({ ok: true }); } },
      ReviewPageFieldCollector: { collect() { return { pageFields: currentFields }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];

  handler({
    type: "APPLY_PAGE_FILL_INTENT",
    actions: [],
    expectedPageUrl: context.window.location.href,
    expectedPageInstanceId: "page-instance",
    expectedPageFingerprint: '[["application.id","case-a"],["old_vehicle.vin","OLD-A"]]',
  }, null, (response) => responses.push(response));

  assert.equal(writes, 0);
  assert.equal(responses[0]?.ok, false);
  assert.match(responses[0]?.message || "", /页面已变化|重新审核/);
});

test("content script rejects an owner-only page fingerprint before writer execution", async () => {
  let handler;
  let writes = 0;
  const fields = { "old_vehicle.owner": "张三" };
  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { handler = listener; } } } },
    document: {},
    window: { location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" } },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewPageFieldWriter: { execute() { writes += 1; return Promise.resolve({ ok: true }); } },
      ReviewPageFieldCollector: { collect() { return { pageFields: fields }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];

  handler({
    type: "APPLY_PAGE_FILL_INTENT",
    actions: [],
    expectedPageUrl: context.window.location.href,
    expectedPageInstanceId: "page-instance",
    expectedPageFingerprint: '[["old_vehicle.owner","张三"]]',
  }, null, (response) => responses.push(response));

  assert.equal(writes, 0);
  assert.equal(responses[0]?.ok, false);
  assert.match(responses[0]?.message || "", /页面已变化|重新审核/);
});

test("content script rejects image focus when the same URL now represents another collected record", () => {
  let handler;
  let focusCalls = 0;
  const fields = { "application.id": "case-b", "old_vehicle.vin": "OLD-B" };
  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { handler = listener; } } } },
    document: {},
    window: { location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" } },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewPageFieldCollector: { collect() { return { pageFields: fields }; } },
      ReviewImageFocus: { focus() { focusCalls += 1; return { ok: true }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];

  handler({
    type: "FOCUS_REVIEW_IMAGE",
    imageId: "unknown-01",
    expectedPageUrl: context.window.location.href,
    expectedPageInstanceId: "page-instance",
    expectedPageFingerprint: '[["application.id","case-a"],["old_vehicle.vin","OLD-A"]]',
  }, null, (response) => responses.push(response));

  assert.equal(focusCalls, 0);
  assert.equal(responses[0]?.ok, false);
  assert.match(responses[0]?.error || "", /页面已变化|重新采集/);
});

test("content script rejects image focus without the active collection token", () => {
  let handler;
  let focusCalls = 0;
  const fields = { "application.id": "case-a", "old_vehicle.vin": "OLD-A" };
  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { handler = listener; } } } },
    document: {},
    window: { location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" } },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewPageFieldCollector: { collect() { return { pageFields: fields }; } },
      ReviewImageFocus: { focus() { focusCalls += 1; return { ok: true }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];

  handler({
    type: "FOCUS_REVIEW_IMAGE",
    imageId: "unknown-01",
    expectedPageUrl: context.window.location.href,
    expectedPageInstanceId: "page-instance",
    expectedPageFingerprint: '[["application.id","case-a"],["old_vehicle.vin","OLD-A"]]',
    expectedCollectionId: "collection-a",
  }, null, (response) => responses.push(response));

  assert.equal(focusCalls, 0);
  assert.equal(responses[0]?.ok, false);
  assert.match(responses[0]?.error || "", /页面已变化|重新采集/);
});

test("content keeps image focus bound to the latest completed collection token", async () => {
  let handler;
  let focusCalls = 0;
  const fields = { "application.id": "case-a", "old_vehicle.vin": "OLD-A" };
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { handler = listener; } },
        sendMessage: async () => ({ ok: true }),
      },
    },
    document: {
      title: "审核页",
      images: [],
      body: { innerText: "", querySelectorAll() { return []; } },
    },
    window: {
      location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" },
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
    },
    console: { info() {} },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewBusinessDetector: { resolve() { return { business: { businessType: "scrap_replacement" } }; } },
      ReviewPageFieldCollector: {
        collect() { return { pageFields: fields, fieldTargets: [], writableTargets: [], unmatchedLabels: [], scannedControls: 0, candidateCount: 0, ambiguousFields: [] }; },
      },
      ReviewBusinessScope: { scopeForLabel() { return null; }, assign() { return []; } },
      ReviewImageCandidates: { select() { return { selected: [], scannedCount: 0, overflow: false }; } },
      ReviewImageFocus: { focus() { focusCalls += 1; return { ok: true }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const responses = [];
  const collect = () => handler({ type: "COLLECT_PAGE_DATA" }, null, (response) => responses.push(response));

  collect();
  collect();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const expired = responses.find((response) => response.collectionIssues?.length);
  const active = responses.find((response) => !response.collectionIssues?.length);
  assert.ok(expired?.collectionId);
  assert.ok(active?.collectionId);
  assert.notEqual(expired.collectionId, active.collectionId);

  const identity = {
    type: "FOCUS_REVIEW_IMAGE",
    imageId: "unknown-01",
    expectedPageUrl: context.window.location.href,
    expectedPageInstanceId: "page-instance",
    expectedPageFingerprint: '[["application.id","case-a"],["old_vehicle.vin","OLD-A"]]',
  };
  const oldResponses = [];
  handler({ ...identity, expectedCollectionId: expired.collectionId }, null, (response) => oldResponses.push(response));
  assert.equal(focusCalls, 0);
  assert.equal(oldResponses[0]?.ok, false);

  const activeResponses = [];
  handler({ ...identity, expectedCollectionId: active.collectionId }, null, (response) => activeResponses.push(response));
  assert.equal(focusCalls, 0);
  assert.equal(activeResponses[0]?.ok, false);
});

test("content rejects a mapped image when its source changes after collection", async () => {
  let handler;
  let clicks = 0;
  const fields = { "application.id": "case-a", "old_vehicle.vin": "OLD-A" };
  const image = {
    isConnected: true,
    src: "https://images.test/original",
    currentSrc: "https://images.test/original",
    alt: "原始资料",
    className: "",
    naturalWidth: 100,
    naturalHeight: 80,
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 80 }; },
    closest() { return null; },
    getAttribute() { return null; },
    click() { clicks += 1; },
  };
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { handler = listener; } },
        sendMessage: async () => ({ ok: true, mimeType: "image/jpeg", sizeBytes: 1, dataUrl: "data:image/jpeg;base64,AA==" }),
      },
    },
    document: {
      title: "审核页",
      images: [image],
      body: { innerText: "", querySelectorAll() { return []; } },
    },
    window: {
      location: { href: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1" },
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
    },
    console: { info() {} },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewBusinessDetector: { resolve() { return { business: { businessType: "scrap_replacement" } }; } },
      ReviewPageFieldCollector: {
        collect() { return { pageFields: fields, fieldTargets: [], writableTargets: [], unmatchedLabels: [], scannedControls: 0, candidateCount: 0, ambiguousFields: [] }; },
      },
      ReviewBusinessScope: { scopeForLabel() { return null; }, assign() { return []; } },
      ReviewImageCandidates: { select(candidates) { return { selected: candidates, scannedCount: candidates.length, overflow: false }; } },
      ReviewImageFocus: { focus(node) { node.click(); return { ok: true }; } },
    },
  };
  vm.runInNewContext(contentSource, context);
  const collected = [];
  handler({ type: "COLLECT_PAGE_DATA" }, null, (response) => collected.push(response));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const identity = {
    type: "FOCUS_REVIEW_IMAGE",
    imageId: "unknown-01",
    expectedPageUrl: context.window.location.href,
    expectedPageInstanceId: "page-instance",
    expectedPageFingerprint: '[["application.id","case-a"],["old_vehicle.vin","OLD-A"]]',
    expectedCollectionId: collected[0].collectionId,
  };

  const unchanged = [];
  handler(identity, null, (response) => unchanged.push(response));
  assert.equal(unchanged[0]?.ok, true);
  assert.equal(clicks, 1);

  image.currentSrc = "https://images.test/replaced";
  const changed = [];
  handler(identity, null, (response) => changed.push(response));
  assert.equal(changed[0]?.ok, false);
  assert.equal(clicks, 1);
  assert.match(changed[0]?.error || "", /原图已变化|重新采集/);
});

test("manifest grants access to the production review host", () => {
  assert.ok(manifest.host_permissions.includes("https://admin.forjtruck.com/*"));
});

test("collector scans every valid contenteditable form", () => {
  const collectorSource = readFileSync(
    new URL("../public/page-field-collector.js", import.meta.url),
    "utf8",
  );

  assert.match(collectorSource, /\[contenteditable\]:not\(\[contenteditable='false'\]\)/);
});

const REVIEW_PAGE_URL = "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1";
const REVIEW_FIELDS = { "application.id": "case-a", "old_vehicle.vin": "OLD-A" };
const REVIEW_FINGERPRINT = '[["application.id","case-a"],["old_vehicle.vin","OLD-A"]]';

const reviewStep = (overrides) => ({
  step_id: "FIELD-old_vehicle.vin",
  sequence: 3,
  category: "FIELD",
  display_target: "PAGE_FIELD",
  page_field: "old_vehicle.vin",
  requires_reviewer_action: true,
  label: "报废车辆车架号",
  result_status: "CONFLICT",
  reason: "页面车架号与登记证书冲突",
  values: [],
  evidence: [],
  ...overrides,
});

function loadContentWithMarker({ markerResult = { ok: true }, fieldTargets } = {}) {
  let handler;
  const sent = [];
  const calls = { show: [], complete: [], clear: 0 };
  const element = { isConnected: true, scrollIntoView() {}, insertAdjacentElement() {} };
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { handler = listener; } },
        sendMessage: (message) => {
          sent.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    },
    document: {
      title: "审核页",
      images: [],
      body: { innerText: "", querySelectorAll() { return []; } },
    },
    window: {
      location: { href: REVIEW_PAGE_URL },
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
    },
    console: { info() {} },
    globalThis: {
      crypto: { randomUUID: () => "page-instance" },
      ReviewBusinessDetector: { resolve() { return { business: { businessType: "scrap_replacement" } }; } },
      ReviewPageFieldCollector: {
        collect() {
          return {
            pageFields: REVIEW_FIELDS,
            fieldTargets: fieldTargets ?? [{ field: "old_vehicle.vin", element }],
            writableTargets: [],
            unmatchedLabels: [],
            scannedControls: 0,
            candidateCount: 0,
            ambiguousFields: [],
          };
        },
      },
      ReviewBusinessScope: { scopeForLabel() { return null; }, assign() { return []; } },
      ReviewImageCandidates: { select() { return { selected: [], scannedCount: 0, overflow: false }; } },
      ReviewPageMarker: {
        show(target, step, onDecision) {
          calls.show.push({ target, step, onDecision });
          return markerResult;
        },
        complete(stepId, decision) {
          calls.complete.push({ stepId, decision });
          return { ok: true };
        },
        clear() {
          calls.clear += 1;
          return { ok: true };
        },
      },
    },
  };
  vm.runInNewContext(contentSource, context);

  const collected = [];
  handler({ type: "COLLECT_PAGE_DATA" }, null, (response) => collected.push(response));
  return {
    context,
    element,
    sent,
    calls,
    handler: (message) => {
      const responses = [];
      handler(message, null, (response) => responses.push(response));
      return responses[0];
    },
    collect: () => new Promise((resolve) => setTimeout(() => resolve(collected), 0)),
    collected,
  };
}

const identityFor = (collectionId, overrides) => ({
  expectedPageUrl: REVIEW_PAGE_URL,
  expectedPageInstanceId: "page-instance",
  expectedPageFingerprint: REVIEW_FINGERPRINT,
  expectedCollectionId: collectionId,
  ...overrides,
});

test("content script names the page marker message contract", () => {
  assert.match(contentSource, /showReviewFieldStep:\s*"SHOW_REVIEW_FIELD_STEP"/);
  assert.match(contentSource, /completeReviewFieldStep:\s*"COMPLETE_REVIEW_FIELD_STEP"/);
  assert.match(contentSource, /clearReviewFieldMarkers:\s*"CLEAR_REVIEW_FIELD_MARKERS"/);
  assert.match(contentSource, /reviewFieldDecision:\s*"REVIEW_FIELD_DECISION"/);
});

test("content script validates the mapped collection and the live element before marking", () => {
  assert.match(contentSource, /entry\.collectionId !== activeCollectionId/);
  assert.match(contentSource, /entry\.element\?\.isConnected/);
  // A refused target is never re-searched by label, selector, or similarity.
  assert.doesNotMatch(contentSource, /querySelector\([^)]*label/);
  assert.equal(contentSource.match(/reviewFieldElements\.set\(/g)?.length, 1);
});

test("content script marks the mapped field and forwards one reviewer decision", async () => {
  const loaded = loadContentWithMarker();
  const [collection] = await loaded.collect();
  const step = reviewStep({});

  const response = loaded.handler({
    type: "SHOW_REVIEW_FIELD_STEP",
    step,
    ...identityFor(collection.collectionId),
  });

  assert.equal(response.ok, true);
  assert.equal(loaded.calls.show.length, 1);
  assert.equal(loaded.calls.show[0].target, loaded.element);
  assert.equal(loaded.calls.show[0].step.step_id, step.step_id);

  loaded.calls.show[0].onDecision("CONFIRMED");
  assert.equal(loaded.sent.length, 1);
  assert.equal(
    JSON.stringify(loaded.sent[0]),
    JSON.stringify({
      type: "REVIEW_FIELD_DECISION",
      stepId: step.step_id,
      decision: "CONFIRMED",
      pageInstanceId: "page-instance",
      collectionId: collection.collectionId,
    }),
  );

  // A repeated decision event never produces a second message.
  loaded.calls.show[0].onDecision("MARKED_EXCEPTION");
  assert.equal(loaded.sent.length, 1);
});

test("content script drops an unknown decision value but still forwards the real one", async () => {
  const loaded = loadContentWithMarker();
  const [collection] = await loaded.collect();

  loaded.handler({ type: "SHOW_REVIEW_FIELD_STEP", step: reviewStep({}), ...identityFor(collection.collectionId) });
  loaded.calls.show[0].onDecision("PASSED");
  assert.equal(loaded.sent.length, 0);

  loaded.calls.show[0].onDecision("MARKED_EXCEPTION");
  assert.equal(loaded.sent.length, 1);
  assert.equal(
    JSON.stringify(loaded.sent[0]),
    JSON.stringify({
      type: "REVIEW_FIELD_DECISION",
      stepId: "FIELD-old_vehicle.vin",
      decision: "MARKED_EXCEPTION",
      pageInstanceId: "page-instance",
      collectionId: collection.collectionId,
    }),
  );
});

test("content script refuses to mark for a stale collection token", async () => {
  const loaded = loadContentWithMarker();
  await loaded.collect();

  const response = loaded.handler({
    type: "SHOW_REVIEW_FIELD_STEP",
    step: reviewStep({}),
    ...identityFor("page-instance:99"),
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /页面已变化|重新审核/);
  assert.equal(loaded.calls.show.length, 0);
});

test("content script refuses a mapped element that left the DOM instead of refinding it", async () => {
  const loaded = loadContentWithMarker();
  const [collection] = await loaded.collect();
  loaded.element.isConnected = false;

  const response = loaded.handler({
    type: "SHOW_REVIEW_FIELD_STEP",
    step: reviewStep({}),
    ...identityFor(collection.collectionId),
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /页面字段已变化|重新审核/);
  assert.equal(loaded.calls.show.length, 0);
});

test("content script refuses a step whose page field was never uniquely collected", async () => {
  const loaded = loadContentWithMarker();
  const [collection] = await loaded.collect();

  const response = loaded.handler({
    type: "SHOW_REVIEW_FIELD_STEP",
    step: reviewStep({ step_id: "FIELD-new_vehicle.vin", page_field: "new_vehicle.vin" }),
    ...identityFor(collection.collectionId),
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /页面字段已变化|重新审核/);
  assert.equal(loaded.calls.show.length, 0);
});

test("content script reports a marker refusal to the side panel", async () => {
  const loaded = loadContentWithMarker({ markerResult: { ok: false, error: "页面字段已变化，请重新审核" } });
  const [collection] = await loaded.collect();

  const response = loaded.handler({
    type: "SHOW_REVIEW_FIELD_STEP",
    step: reviewStep({}),
    ...identityFor(collection.collectionId),
  });

  assert.equal(response.ok, false);
  assert.match(response.error || "", /页面字段已变化/);
});

test("content script completes a step marker only for the collected record", async () => {
  const loaded = loadContentWithMarker();
  const [collection] = await loaded.collect();

  const response = loaded.handler({
    type: "COMPLETE_REVIEW_FIELD_STEP",
    stepId: "FIELD-old_vehicle.vin",
    decision: "MARKED_EXCEPTION",
    ...identityFor(collection.collectionId),
  });
  assert.equal(response.ok, true);
  assert.deepEqual(loaded.calls.complete, [{ stepId: "FIELD-old_vehicle.vin", decision: "MARKED_EXCEPTION" }]);

  const stale = loaded.handler({
    type: "COMPLETE_REVIEW_FIELD_STEP",
    stepId: "FIELD-old_vehicle.vin",
    decision: "CONFIRMED",
    ...identityFor(collection.collectionId, { expectedPageFingerprint: '[["application.id","case-b"]]' }),
  });
  assert.equal(stale.ok, false);
  assert.equal(loaded.calls.complete.length, 1);
});

test("content script clears markers only for the collected record", async () => {
  const loaded = loadContentWithMarker();
  const [collection] = await loaded.collect();
  const clearsAfterCollection = loaded.calls.clear;

  const stale = loaded.handler({
    type: "CLEAR_REVIEW_FIELD_MARKERS",
    ...identityFor(collection.collectionId, { expectedPageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?case=next" }),
  });
  assert.equal(stale.ok, false);
  assert.equal(loaded.calls.clear, clearsAfterCollection);

  const cleared = loaded.handler({ type: "CLEAR_REVIEW_FIELD_MARKERS", ...identityFor(collection.collectionId) });
  assert.equal(cleared.ok, true);
  assert.equal(loaded.calls.clear, clearsAfterCollection + 1);
});

test("content script clears previous markers when a new collection becomes active", async () => {
  const loaded = loadContentWithMarker();
  await loaded.collect();

  loaded.handler({ type: "COLLECT_PAGE_DATA" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(loaded.calls.clear >= 1);
});
