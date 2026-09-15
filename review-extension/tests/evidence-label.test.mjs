import assert from "node:assert/strict";
import test from "node:test";
import { ReviewEvidenceLabel } from "../src/browser/evidence-label.ts";

function loadEvidenceLabel() {
  return ReviewEvidenceLabel;
}

test("formats a structured image source with group order and document name", () => {
  const { label } = loadEvidenceLabel();

  assert.equal(label({
    group_title: "新车资料",
    group_order: 2,
    document_type: "vehicle_license",
    image_index: 6,
  }), "新车资料 · 第2张 · 行驶证");
});

test("falls back to the legacy DOM image number", () => {
  const { label } = loadEvidenceLabel();

  assert.equal(label({ image_index: 2 }), "图片 #3");
  assert.equal(label({}), "图片识别");
});
