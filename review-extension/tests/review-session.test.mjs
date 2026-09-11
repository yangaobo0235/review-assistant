import assert from "node:assert/strict";
import test from "node:test";

import {
  completeMatchedStep,
  createReviewSession,
  currentStep,
  failReviewSession,
  recordReviewerDecision,
} from "../src/reviewSession.ts";

const pageMatch = {
  step_id: "FIELD-old_vehicle.vin",
  sequence: 1,
  category: "FIELD",
  display_target: "PAGE_FIELD",
  page_field: "old_vehicle.vin",
  requires_reviewer_action: false,
  label: "old_vehicle.vin",
  result_status: "MATCH",
  reason: "页面与材料一致",
  values: [],
  evidence: [],
};

const pageConflict = {
  step_id: "FIELD-new_vehicle.vin",
  sequence: 2,
  category: "FIELD",
  display_target: "PAGE_FIELD",
  page_field: "new_vehicle.vin",
  requires_reviewer_action: true,
  label: "new_vehicle.vin",
  result_status: "CONFLICT",
  reason: "页面车架号与发票不一致",
  values: [],
  evidence: [],
};

const assistantMatch = {
  step_id: "RULE-ORIGIN-001",
  sequence: 1,
  category: "BUSINESS_RULE",
  display_target: "ASSISTANT",
  page_field: null,
  requires_reviewer_action: false,
  label: "新车产地",
  result_status: "MATCH",
  reason: "产地符合当地政策",
  values: [],
  evidence: [],
};

const assistantConflict = {
  step_id: "RULE-AFFILIATION-001",
  sequence: 2,
  category: "BUSINESS_RULE",
  display_target: "ASSISTANT",
  page_field: null,
  requires_reviewer_action: true,
  label: "新旧车挂靠主体关系",
  result_status: "INSUFFICIENT",
  reason: "无法确定挂靠主体关系",
  values: [],
  evidence: [],
};

const waitingState = completeMatchedStep(
  createReviewSession([pageMatch, pageConflict]),
  pageMatch.step_id,
);

test("page match auto-advances and page exception waits", () => {
  let state = createReviewSession([pageMatch, pageConflict]);
  state = completeMatchedStep(state, pageMatch.step_id);
  assert.equal(currentStep(state).step_id, pageConflict.step_id);
  assert.equal(state.phase, "WAITING_REVIEWER");
});

test("assistant match is hidden and auto-advances", () => {
  let state = createReviewSession([assistantMatch, assistantConflict]);
  state = completeMatchedStep(state, assistantMatch.step_id);
  assert.equal(currentStep(state).step_id, assistantConflict.step_id);
  assert.equal(state.phase, "WAITING_REVIEWER");
});

test("either reviewer decision advances immediately without mutating backend status", () => {
  const next = recordReviewerDecision(waitingState, pageConflict.step_id, "MARKED_EXCEPTION");
  assert.equal(next.index, waitingState.index + 1);
  assert.equal(next.decisions[pageConflict.step_id], "MARKED_EXCEPTION");
  assert.equal(pageConflict.result_status, "CONFLICT");

  const confirmed = recordReviewerDecision(waitingState, pageConflict.step_id, "CONFIRMED");
  assert.equal(confirmed.index, waitingState.index + 1);
  assert.equal(confirmed.decisions[pageConflict.step_id], "CONFIRMED");
  assert.equal(confirmed.phase, "COMPLETED");
  assert.equal(currentStep(confirmed), null);
});

test("copies backend steps into sequence order without mutating or freezing the payload", () => {
  const first = { ...pageMatch, step_id: "A", sequence: 1 };
  const second = { ...pageConflict, step_id: "B", sequence: 2 };
  const third = { ...assistantConflict, step_id: "C", sequence: 3 };
  const payload = [third, first, second];

  const state = createReviewSession(payload);

  assert.deepEqual(state.steps.map((step) => step.step_id), ["A", "B", "C"]);
  assert.deepEqual(payload.map((step) => step.step_id), ["C", "A", "B"]);
  assert.notEqual(state.steps[0], first);
  assert.equal(Object.isFrozen(first), false);
  assert.equal(Object.isFrozen(first.evidence), false);
});

test("every session state is frozen against in-place mutation", () => {
  const state = createReviewSession([pageMatch, pageConflict]);

  assert.throws(() => { state.phase = "COMPLETED"; }, TypeError);
  assert.throws(() => { state.decisions[pageMatch.step_id] = "CONFIRMED"; }, TypeError);
  assert.throws(() => { state.completedStepIds.push(pageMatch.step_id); }, TypeError);
  assert.throws(() => { state.steps[0].result_status = "CONFLICT"; }, TypeError);
  assert.throws(() => { state.steps.sort(() => 1); }, TypeError);
});

test("opens waiting when the first sorted step needs the reviewer", () => {
  const state = createReviewSession([assistantConflict]);
  assert.equal(state.phase, "WAITING_REVIEWER");
  assert.equal(currentStep(state).step_id, assistantConflict.step_id);
  assert.equal(state.index, 0);
});

test("an empty step list is completed immediately", () => {
  const state = createReviewSession([]);
  assert.equal(state.phase, "COMPLETED");
  assert.equal(currentStep(state), null);
});

test("stale or duplicate events never advance the session", () => {
  const running = createReviewSession([pageMatch, pageConflict]);

  // 旧按钮：不是当前步骤。
  assert.equal(completeMatchedStep(running, "FIELD-stale"), running);
  // 越过等待人工的步骤。
  assert.equal(completeMatchedStep(running, pageConflict.step_id), running);
  // 还未轮到的步骤不能提前记录人工选择。
  assert.equal(recordReviewerDecision(running, pageConflict.step_id, "CONFIRMED"), running);

  const advanced = completeMatchedStep(running, pageMatch.step_id);
  // 重复事件：同一步骤第二次完成无效。
  assert.equal(completeMatchedStep(advanced, pageMatch.step_id), advanced);
  assert.equal(recordReviewerDecision(advanced, pageMatch.step_id, "CONFIRMED"), advanced);
});

test("matched steps only advance through completeMatchedStep, never through a decision", () => {
  const running = createReviewSession([pageMatch]);
  assert.equal(recordReviewerDecision(running, pageMatch.step_id, "MARKED_EXCEPTION"), running);
});

test("decisions are recorded per step and keep earlier state untouched", () => {
  const waiting = createReviewSession([assistantConflict]);
  const next = recordReviewerDecision(waiting, assistantConflict.step_id, "MARKED_EXCEPTION");

  assert.deepEqual(waiting.decisions, {});
  assert.notEqual(next.decisions, waiting.decisions);
  assert.deepEqual(next.decisions, { "RULE-AFFILIATION-001": "MARKED_EXCEPTION" });
  assert.deepEqual(next.completedStepIds, [assistantConflict.step_id]);
  assert.equal(assistantConflict.result_status, "INSUFFICIENT");
});

test("unknown decision values are ignored", () => {
  const waiting = createReviewSession([assistantConflict]);
  assert.equal(recordReviewerDecision(waiting, assistantConflict.step_id, "PASSED"), waiting);
});

test("failReviewSession enters STALE_PAGE and blocks every later transition", () => {
  const running = createReviewSession([pageMatch, pageConflict]);

  const stale = failReviewSession(running, "页面已变化，请重新审核");
  assert.equal(stale.phase, "STALE_PAGE");
  assert.equal(stale.blockingIssue, "页面已变化，请重新审核");
  assert.equal(stale.index, running.index);

  assert.equal(completeMatchedStep(stale, pageMatch.step_id), stale);
  assert.equal(recordReviewerDecision(stale, pageMatch.step_id, "CONFIRMED"), stale);
  // 第一个失效原因保留，后续失败不覆盖。
  assert.equal(failReviewSession(stale, "其他问题"), stale);

  const waiting = completeMatchedStep(running, pageMatch.step_id);
  const staleWhileWaiting = failReviewSession(waiting, "采集 ID 已失效");
  assert.equal(staleWhileWaiting.phase, "STALE_PAGE");
  assert.equal(recordReviewerDecision(staleWhileWaiting, pageConflict.step_id, "CONFIRMED"), staleWhileWaiting);
});

test("a completed session ignores further events", () => {
  let state = createReviewSession([pageMatch]);
  state = completeMatchedStep(state, pageMatch.step_id);

  assert.equal(state.phase, "COMPLETED");
  assert.deepEqual(state.completedStepIds, [pageMatch.step_id]);
  assert.equal(completeMatchedStep(state, pageMatch.step_id), state);
  assert.equal(recordReviewerDecision(state, pageMatch.step_id, "CONFIRMED"), state);
});
