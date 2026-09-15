import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const publicAsset = (name) => readFileSync(
  new URL(`../public/${name}`, import.meta.url),
  "utf8",
);

test("loads image normalization before the content collector", () => {
  const manifest = JSON.parse(publicAsset("manifest.json"));
  const scripts = manifest.content_scripts[0].js;

  assert.deepEqual(scripts, ["content.js"]);
});

test("normalizes remote image blobs in the background worker", () => {
  const source = readFileSync(new URL("../src/browser/background.ts", import.meta.url), "utf8");

  assert.match(source, /ReviewImageNormalization/);
  assert.match(source, /ReviewImageNormalization\.readResponseBlobWithLimit\(response\)/);
  assert.match(source, /ReviewImageNormalization\.normalizeBlob\(blob\)/);
  assert.doesNotMatch(source, /response\.blob\(\)/);
  assert.doesNotMatch(source, /Image exceeds 5 MB limit/);
  assert.doesNotMatch(source, /image fetch start", \{ url:/);
  assert.doesNotMatch(source, /image fetch failed", \{\s*url:/);
});

test("normalizes blob and data image assets in the content collector", () => {
  const source = readFileSync(new URL("../src/browser/content.ts", import.meta.url), "utf8");

  assert.match(source, /ReviewImageNormalization\.normalizeBlob\(blob\)/);
  assert.doesNotMatch(source, /图片超过 5 MB 限制/);
});
