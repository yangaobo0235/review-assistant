import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPageReviewMarkers,
  completePageReviewStep,
  showPageReviewStep,
  subscribePageReviewDecisions,
} from "../src/pageReviewClient.ts";

const pageData = {
  pageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1",
  sourceTabId: 42,
  pageInstanceId: "page-instance",
  pageFingerprint: '[["application.id","case-a"]]',
  collectionId: "collection-1",
};

const step = {
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

const identityFields = {
  expectedPageUrl: pageData.pageUrl,
  expectedPageInstanceId: pageData.pageInstanceId,
  expectedPageFingerprint: pageData.pageFingerprint,
  expectedCollectionId: pageData.collectionId,
};

const makeChromeApi = (response = { ok: true }) => {
  const sent = [];
  const listeners = [];
  return {
    sent,
    listeners,
    emit: (message) => {
      for (const listener of [...listeners]) listener(message, {}, () => {});
    },
    api: {
      tabs: {
        sendMessage: async (tabId, message) => {
          sent.push({ tabId, message });
          return response;
        },
      },
      runtime: {
        onMessage: {
          addListener: (listener) => { listeners.push(listener); },
          removeListener: (listener) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
      },
    },
  };
};

const decisionEvent = (overrides = {}) => ({
  type: "REVIEW_FIELD_DECISION",
  stepId: step.step_id,
  decision: "CONFIRMED",
  pageInstanceId: pageData.pageInstanceId,
  collectionId: pageData.collectionId,
  ...overrides,
});

test("showPageReviewStep sends the step with the full collected identity", async () => {
  const { api, sent } = makeChromeApi();

  const result = await showPageReviewStep(step, pageData, api);

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, pageData.sourceTabId);
  assert.deepEqual(sent[0].message, {
    type: "SHOW_REVIEW_FIELD_STEP",
    step,
    expectedPageUrl: pageData.pageUrl,
    expectedPageInstanceId: pageData.pageInstanceId,
    expectedPageFingerprint: pageData.pageFingerprint,
    expectedCollectionId: pageData.collectionId,
  });
  assert.equal(sent[0].message.step, step);
});

test("completePageReviewStep sends the step id with the same identity", async () => {
  const { api, sent } = makeChromeApi();

  await completePageReviewStep(step.step_id, pageData, api);

  assert.deepEqual(sent[0].message, {
    type: "COMPLETE_REVIEW_FIELD_STEP",
    stepId: step.step_id,
    ...identityFields,
  });
  assert.equal(sent[0].tabId, pageData.sourceTabId);
});

test("clearPageReviewMarkers sends an identity-only clear message", async () => {
  const { api, sent } = makeChromeApi();

  await clearPageReviewMarkers(pageData, api);

  assert.deepEqual(sent[0].message, {
    type: "CLEAR_REVIEW_FIELD_MARKERS",
    ...identityFields,
  });
});

test("content script refusals are surfaced to the caller untouched", async () => {
  const refusal = { ok: false, error: "页面已变化，请重新审核" };
  const { api } = makeChromeApi(refusal);

  assert.deepEqual(await showPageReviewStep(step, pageData, api), refusal);
  assert.deepEqual(await completePageReviewStep(step.step_id, pageData, api), refusal);
  assert.deepEqual(await clearPageReviewMarkers(pageData, api), refusal);
});

test("an incomplete collected identity is refused before any message is sent", async () => {
  const { api, sent } = makeChromeApi();

  for (const broken of [
    { ...pageData, collectionId: "" },
    { ...pageData, pageInstanceId: "" },
    { ...pageData, pageFingerprint: "" },
    { ...pageData, pageUrl: "" },
    { ...pageData, sourceTabId: undefined },
  ]) {
    const shown = await showPageReviewStep(step, broken, api);
    assert.equal(shown.ok, false);
    assert.match(shown.error, /标识不完整|重新审核/);
  }
  assert.equal(sent.length, 0);

  const completed = await completePageReviewStep("", pageData, api);
  assert.equal(completed.ok, false);
  assert.equal(sent.length, 0);
});

const subscribe = (api, overrides = {}) => {
  const received = [];
  const context = {
    pageInstanceId: pageData.pageInstanceId,
    collectionId: pageData.collectionId,
    getCurrentStepId: () => step.step_id,
    ...overrides,
  };
  const unsubscribe = subscribePageReviewDecisions(context, (event) => received.push(event), api);
  return { received, unsubscribe };
};

test("a fully matching reviewer decision is delivered once", () => {
  const chrome = makeChromeApi();
  const { received } = subscribe(chrome.api);

  chrome.emit(decisionEvent());

  assert.deepEqual(received, [{
    stepId: step.step_id,
    decision: "CONFIRMED",
    pageInstanceId: pageData.pageInstanceId,
    collectionId: pageData.collectionId,
  }]);
});

test("decisions from another page, collection, or step are ignored", () => {
  const chrome = makeChromeApi();
  const { received } = subscribe(chrome.api);

  chrome.emit(decisionEvent({ pageInstanceId: "page-instance-2" }));
  chrome.emit(decisionEvent({ collectionId: "collection-2" }));
  chrome.emit(decisionEvent({ stepId: "FIELD-new_vehicle.vin" }));
  chrome.emit(decisionEvent({ decision: "PASSED" }));
  chrome.emit({ ...decisionEvent(), type: "SOME_OTHER_MESSAGE" });
  chrome.emit(null);
  chrome.emit("REVIEW_FIELD_DECISION");

  assert.deepEqual(received, []);
});

test("the subscription follows the session as steps advance", () => {
  const chrome = makeChromeApi();
  let currentStepId = step.step_id;
  const { received } = subscribe(chrome.api, { getCurrentStepId: () => currentStepId });

  currentStepId = "FIELD-new_vehicle.vin";
  chrome.emit(decisionEvent());
  assert.deepEqual(received, []);

  chrome.emit(decisionEvent({ stepId: "FIELD-new_vehicle.vin", decision: "MARKED_EXCEPTION" }));
  assert.equal(received.length, 1);
  assert.equal(received[0].decision, "MARKED_EXCEPTION");

  // 会话已结束时（没有当前步骤）不再接受任何人工事件。
  currentStepId = null;
  chrome.emit(decisionEvent({ stepId: "FIELD-new_vehicle.vin" }));
  assert.equal(received.length, 1);
});

test("unsubscribe removes the runtime listener so later events are dropped", () => {
  const chrome = makeChromeApi();
  const { received, unsubscribe } = subscribe(chrome.api);
  assert.equal(chrome.listeners.length, 1);

  unsubscribe();

  assert.equal(chrome.listeners.length, 0);
  chrome.emit(decisionEvent());
  assert.deepEqual(received, []);
});
