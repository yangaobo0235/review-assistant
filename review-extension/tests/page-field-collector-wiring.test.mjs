import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
);
const contentSource = readFileSync(
  new URL("../src/browser/content.ts", import.meta.url),
  "utf8",
);

function runContent(context) {
  const cache = new Map();
  const load = (file) => {
    const absolute = path.resolve(file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const output = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = (specifier) => {
      if (!specifier.startsWith(".")) return require(specifier);
      const injected = {
        "./business-detector.ts": "ReviewBusinessDetector",
        "./business-scope.ts": "ReviewBusinessScope",
        "./image-candidates.ts": "ReviewImageCandidates",
        "./image-focus.ts": "ReviewImageFocus",
        "./image-normalization.ts": "ReviewImageNormalization",
        "./page-field-collector.ts": "ReviewPageFieldCollector",
        "./page-field-writer.ts": "ReviewPageFieldWriter",
      }[specifier];
      if (injected && context.globalThis?.[injected]) return { [injected]: context.globalThis[injected] };
      let target = path.resolve(path.dirname(absolute), specifier);
      if (!path.extname(target)) target = [".ts", ".tsx", ".js"].map((ext) => target + ext).find(existsSync);
      return load(target);
    };
    vm.runInNewContext(output, { ...context, module, exports: module.exports, require: localRequire }, { filename: absolute });
    return module.exports;
  };
  load(fileURLToPath(new URL("../src/browser/content.ts", import.meta.url)));
}

test("loads the page field collector before the content script", () => {
  const scripts = manifest.content_scripts[0].js;

  assert.deepEqual(scripts, ["content.js"]);
});

test("does not load the retired host-page review marker", () => {
  const scripts = manifest.content_scripts[0].js;
  assert.equal(scripts.includes("page-review-marker.js"), false);
  assert.deepEqual(scripts, [
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
  assert.match(contentSource, /reviewFieldElements\.set\(field, \{ element, collectionId/);
  const expiredGuard = contentSource.indexOf("latestCollectionId !== collectionId");
  const fieldMapReplace = contentSource.indexOf("reviewFieldElements.clear()");
  assert.ok(expiredGuard >= 0);
  assert.ok(fieldMapReplace > expiredGuard);
});

test("content script sends field target snapshots without DOM elements", async () => {
  let handler;
  const element = { isConnected: true };
  const fields = { "application.id": "case-a", "old_vehicle.vin": "OLD-A" };
  const reviewFields = [{ field: "old_vehicle.vin", label: "报废车辆车架号", value: "OLD-A", controlType: "text", editable: true, order: 1, section: "old_vehicle" }];
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
        collect() { return { pageFields: fields, reviewFields, fieldTargets: [{ field: "old_vehicle.vin", element }], writableTargets: [], unmatchedLabels: [], scannedControls: 1, candidateCount: 0, ambiguousFields: [] }; },
      },
      ReviewBusinessScope: { scopeForLabel() { return null; }, assign() { return []; } },
      ReviewImageCandidates: { select() { return { selected: [], scannedCount: 0, overflow: false }; } },
    },
  };
  runContent(context);
  const responses = [];

  handler({ type: "COLLECT_PAGE_DATA" }, null, (response) => responses.push(response));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The response crosses a vm realm boundary, so compare JSON instead of prototypes.
  assert.equal(
    JSON.stringify(responses[0]?.fieldTargets),
    JSON.stringify([{ field: "old_vehicle.vin", present: true }]),
  );
  assert.equal(Object.hasOwn(responses[0].fieldTargets[0], "element"), false);
  assert.equal(JSON.stringify(responses[0].reviewFields), JSON.stringify(reviewFields));
  assert.equal(responses[0].collectionDiagnostics.reviewFieldCount, 1);
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
  runContent(context);
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
  runContent(context);
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
  runContent(context);
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
  runContent(context);
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
  runContent(context);
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
  runContent(context);
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
  // 被取代的采集必须带回真实原因和已识别的业务，面板不得退化为“无法识别业务”。
  assert.equal(expired.staleCollection, true);
  assert.equal(expired.collectionIssues.length, 1);
  assert.equal(expired.collectionIssues[0], "页面采集已过期，请重新采集");
  assert.equal(expired.businessType, "scrap_replacement");
  assert.equal(active.staleCollection, undefined);

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
  runContent(context);
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
  assert.ok(manifest.host_permissions.includes("http://175.178.6.214:18110/*"));
});

test("collector scans every valid contenteditable form", () => {
  const collectorSource = readFileSync(
    new URL("../src/browser/page-field-collector.ts", import.meta.url),
    "utf8",
  );

  assert.match(collectorSource, /\[contenteditable\]:not\(\[contenteditable='false'\]\)/);
});

test("content script has no host-page review marker protocol", () => {
  assert.doesNotMatch(contentSource, /SHOW_REVIEW_FIELD_STEP|COMPLETE_REVIEW_FIELD_STEP|CLEAR_REVIEW_FIELD_MARKERS|REVIEW_FIELD_DECISION/);
  assert.doesNotMatch(contentSource, /ReviewPageMarker/);
});
