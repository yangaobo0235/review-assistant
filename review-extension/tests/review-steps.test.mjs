import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isFieldFirstTaskVisible } from "../src/reviewSteps.ts";

const steps = [
  {
    step_id: "BUSINESS-AFFILIATION-SUBJECT-001",
    sequence: 3,
    category: "BUSINESS_RULE",
    label: "主体关系",
    result_status: "CONFLICT",
    reason: "两家公司法人不一致",
    values: [{ source: "旧车主体", value: "甲运输有限公司" }],
    evidence: [],
  },
  {
    step_id: "BUSINESS-POLICY-ORIGIN-001",
    sequence: 1,
    category: "BUSINESS_RULE",
    label: "新车产地",
    result_status: "MATCH",
    reason: "产地符合当地政策",
    values: [],
    evidence: [],
  },
];

const scrapPolicy = { materialTasksVisible: false };
const vehicleSourcePolicy = { materialTasksVisible: true };

test("field-first presentation policy hides affiliation tasks by stable identity", () => {
  const hidden = [
    { ...steps[0], step_id: "BUSINESS-AFFILIATION-SUBJECT-001" },
    { ...steps[0], step_id: "BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME" },
    { ...steps[0], step_id: "FIELD-old_vehicle.affiliation", category: "FIELD", page_target_field: "old_vehicle.affiliation" },
  ];

  assert.equal(hidden.every((step) => !isFieldFirstTaskVisible(step, scrapPolicy)), true);
  assert.equal(isFieldFirstTaskVisible(steps[1], scrapPolicy), true);
});

test("material tasks are hidden only for profiles that place them elsewhere", () => {
  const material = [
    { ...steps[0], step_id: "MATERIAL-GROUP", category: "MATERIAL" },
    { ...steps[0], step_id: "MATERIAL-MISSING_MATERIAL-1", category: "MATERIAL" },
    { ...steps[0], step_id: "BUSINESS-MATERIAL-COMPLETENESS", category: "MATERIAL" },
  ];

  assert.equal(material.every((step) => !isFieldFirstTaskVisible(step, scrapPolicy)), true);
  // 车源审核的“行驶证必须有、登记证书与铭牌二选一”必须能被审核员看到。
  assert.equal(material.every((step) => isFieldFirstTaskVisible(step, vehicleSourcePolicy)), true);
});

test("keeps generic step evidence readable in a narrow panel", () => {
  const stylesheet = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

  assert.match(stylesheet, /\.stepper-evidence li,[\s\S]*overflow-wrap: anywhere/);
  assert.match(stylesheet, /\.stepper-evidence-meta[\s\S]*overflow-wrap: anywhere/);
});
