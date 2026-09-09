import assert from "node:assert/strict";
import test from "node:test";

import {
  businessLabels,
  fieldLabel,
  groupStatusLabel,
  manualBusinessSelection,
  statusLabel,
} from "../src/reviewPanelConfig.ts";

test("builds stable manual business metadata", () => {
  assert.deepEqual(manualBusinessSelection("transfer"), {
    businessType: "transfer",
    region: "default",
    profileVersion: "1.0",
    workflowStage: "transfer",
    selectionMode: "MANUAL",
  });
  assert.equal(manualBusinessSelection("scrap_replacement").region, "qingdao");
});

test("presents stable business, field, and status labels", () => {
  assert.equal(businessLabels.AUTO, "自动识别");
  assert.equal(fieldLabel("transfer.vin"), "车架号");
  assert.equal(fieldLabel("unknown.field"), "unknown.field");
  assert.equal(statusLabel("REVIEW_REQUIRED"), "待复核");
  assert.equal(groupStatusLabel("PARTIAL"), "部分完成");
});
