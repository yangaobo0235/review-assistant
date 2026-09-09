import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("collector scans every valid contenteditable form", () => {
  const collectorSource = readFileSync(
    new URL("../public/page-field-collector.js", import.meta.url),
    "utf8",
  );

  assert.match(collectorSource, /\[contenteditable\]:not\(\[contenteditable='false'\]\)/);
});
