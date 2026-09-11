import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  acknowledgeStep,
  createReviewStepState,
  nextReviewStep,
  previousReviewStep,
  reviewStepTitle,
  isAffiliationRelationshipStep,
  reviewStepStatusLabel,
  sortedReviewSteps,
} from "../src/reviewSteps.ts";

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

test("keeps exactly the backend review steps in sequence order", () => {
  const result = sortedReviewSteps(steps);

  assert.deepEqual(result.map((step) => step.step_id), [
    "BUSINESS-POLICY-ORIGIN-001",
    "BUSINESS-AFFILIATION-SUBJECT-001",
  ]);
  assert.equal(result.length, 2);
});

test("records an exception acknowledgement only in local step state", () => {
  const state = createReviewStepState(steps);
  const next = acknowledgeStep(state, "BUSINESS-AFFILIATION-SUBJECT-001", "MANUAL_REVIEW");

  assert.equal(next.decisions["BUSINESS-AFFILIATION-SUBJECT-001"], "MANUAL_REVIEW");
  assert.equal(steps[0].result_status, "CONFLICT");
  assert.equal(next.index, 0);
});

test("moves through steps without requiring a decision for matched items", () => {
  const initial = createReviewStepState(steps);
  const afterNext = nextReviewStep(initial);
  const afterPrevious = previousReviewStep(afterNext);

  assert.equal(afterNext.index, 1);
  assert.equal(afterPrevious.index, 0);
  assert.equal(reviewStepStatusLabel("MATCH"), "已核验");
  assert.equal(reviewStepStatusLabel("INSUFFICIENT"), "证据不足");
});

test("uses the reviewer-facing field label while preserving business rule titles", () => {
  assert.equal(reviewStepTitle({ ...steps[1], category: "FIELD", label: "new_vehicle.vin" }), "新车车架号");
  assert.equal(reviewStepTitle(steps[0]), "主体关系");
});

test("identifies only the affiliation relationship conclusion, not auxiliary safeguards", () => {
  assert.equal(isAffiliationRelationshipStep(steps[0]), true);
  assert.equal(isAffiliationRelationshipStep({ ...steps[0], step_id: "BUSINESS-AFFILIATION-AUX-NEW-VIN", label: "OCR新车车架号" }), false);
});

test("renders traceable image evidence and focus controls for every review step category", () => {
  const stepperSource = readFileSync(
    new URL("../src/components/ReviewFieldStepper.tsx", import.meta.url),
    "utf8",
  );
  const resultsSource = readFileSync(
    new URL("../src/components/ReviewResults.tsx", import.meta.url),
    "utf8",
  );

  assert.match(stepperSource, /ReviewFieldStepper\(\{ reviewSteps, onFocusImage \}/);
  assert.match(stepperSource, /<StepEvidence evidence=\{step\.evidence\} onFocusImage=\{onFocusImage\} \/>/);
  assert.match(stepperSource, /function StepEvidence\(\{ evidence, onFocusImage \}/);
  assert.match(stepperSource, /文档类型：/);
  assert.match(stepperSource, /来源标识：/);
  assert.match(stepperSource, /原图标识：/);
  assert.match(stepperSource, /字段：/);
  assert.match(stepperSource, /查看原图/);
  assert.match(stepperSource, /onFocusImage\(item\.image_id\)/);
  assert.match(resultsSource, /<ReviewFieldStepper[\s\S]*onFocusImage=\{onFocusImage\}/);
});

test("keeps generic step evidence readable in a narrow panel", () => {
  const stylesheet = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

  assert.match(stylesheet, /\.stepper-evidence li,[\s\S]*overflow-wrap: anywhere/);
  assert.match(stylesheet, /\.stepper-evidence-meta[\s\S]*overflow-wrap: anywhere/);
});
