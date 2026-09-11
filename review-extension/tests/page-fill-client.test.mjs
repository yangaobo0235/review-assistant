import assert from "node:assert/strict";
import test from "node:test";

import { applyPageFillIntent } from "../src/pageFillClient.ts";

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
  let sent = false;
  const result = await applyPageFillIntent(
    [{ field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "PERSONAL" }],
    { tabId: 42, pageUrl: "https://example.test", pageInstanceId: "" },
    { tabs: { sendMessage: async () => { sent = true; } } },
  );

  assert.equal(result.ok, false);
  assert.equal(sent, false);
});
