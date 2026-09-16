import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyPageFieldGroupValue, applyPageFillIntent } from "../src/pageFillClient.ts";

test("sends one authorized message for both fields in a composite write", async () => {
  const messages = [];
  const chromeApi = {
    tabs: {
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        return { ok: true, message: "组合字段已同时回填并回读", actions: [
          { field: "invoice.code", status: "FILLED" },
          { field: "invoice.invoice_no", status: "FILLED" },
        ] };
      },
    },
  };
  const target = {
    tabId: 42,
    pageUrl: "https://admin.example.test/review/1",
    pageInstanceId: "page-a",
    pageFingerprint: "[[\"application.id\",\"case-a\"]]",
    collectionId: "page-a:3",
  };
  const action = {
    fields: ["invoice.code", "invoice.invoice_no"],
    value: "INV-001",
    expectedValues: { "invoice.code": "", "invoice.invoice_no": "" },
  };

  const result = await applyPageFieldGroupValue(action, target, chromeApi);

  assert.equal(result.ok, true);
  assert.deepEqual(messages[0], {
    tabId: 42,
    message: {
      type: "APPLY_PAGE_FIELD_GROUP_VALUE",
      action,
      expectedPageUrl: target.pageUrl,
      expectedPageInstanceId: target.pageInstanceId,
      expectedPageFingerprint: target.pageFingerprint,
      expectedCollectionId: target.collectionId,
    },
  });
});

test("sends the final page fill intent only to the originally collected page instance", async () => {
  const messages = [];
  const chromeApi = {
    tabs: {
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        return { ok: true, message: "挂靠字段已填写并回读" };
      },
    },
  };
  const intent = [{ field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "PERSONAL" }];

  const target = {
    tabId: 42,
    pageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1",
    pageInstanceId: "page-a",
    pageFingerprint: '[["application.id","case-a"]]',
    collectionId: "page-a:3",
  };

  const result = await applyPageFillIntent(intent, target, chromeApi);

  assert.equal(result.ok, true);
  assert.deepEqual(messages, [{
    tabId: 42,
    message: {
      type: "APPLY_PAGE_FILL_INTENT",
      actions: intent,
      expectedPageUrl: target.pageUrl,
      expectedPageInstanceId: target.pageInstanceId,
      expectedPageFingerprint: target.pageFingerprint,
      expectedCollectionId: target.collectionId,
    },
  }]);
});

test("skips browser messaging when the backend returned no fill intent", async () => {
  let queried = false;
  const result = await applyPageFillIntent(
    [],
    { tabId: 42, pageUrl: "https://example.test", pageInstanceId: "page-a", pageFingerprint: "fingerprint" },
    { tabs: { query: async () => { queried = true; return []; } } },
  );

  assert.deepEqual(result, { ok: true, skipped: true, message: "本次审核没有页面填写动作" });
  assert.equal(queried, false);
});

test("refuses to send when the collected page identity is incomplete", async () => {
  for (const target of [
    { tabId: 42, pageUrl: "https://example.test", pageInstanceId: "" },
    {
      tabId: 42,
      pageUrl: "https://example.test",
      pageInstanceId: "page-a",
      pageFingerprint: '[["application.id","case-a"]]',
      collectionId: "",
    },
  ]) {
    let sent = false;
    const result = await applyPageFillIntent(
      [{ field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "PERSONAL" }],
      target,
      { tabs: { sendMessage: async () => { sent = true; } } },
    );

    assert.equal(result.ok, false);
    assert.equal(sent, false);
  }
});

test("startReview no longer auto-fills and the workflow exposes applyAffiliationFill", () => {
  const workflowSource = readFileSync(
    new URL("../src/hooks/useReviewWorkflow.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(workflowSource,
    /finalSnapshot\.result\?\.page_fill_intent[\s\S]*applyPageFillIntent/);
  assert.match(workflowSource, /applyAffiliationFill/);

  const startReviewSource = workflowSource.slice(
    workflowSource.indexOf("const startReview"),
    workflowSource.indexOf("const applyAffiliationFill"),
  );
  assert.ok(startReviewSource.length > 0);
  assert.doesNotMatch(startReviewSource, /applyPageFillIntent|page_fill_intent/);
});

test("content script validates the active collection before applying a fill intent", () => {
  const source = readFileSync(new URL("../src/browser/content.ts", import.meta.url), "utf8");
  const branch = source.slice(
    source.indexOf("MESSAGE_TYPES.applyPageFillIntent"),
    source.indexOf("MESSAGE_TYPES.focusReviewImage"),
  );

  assert.ok(branch.length > 0);
  assert.match(branch, /if \(!sameReviewIdentity\(message\)\)/);
  assert.match(branch, /ReviewPageFieldWriter\.execute\(document, \(message\.actions \|\| \[\]\) as PageFillAction\[\], \(\) => sameReviewIdentity\(message\)\)/);
});
