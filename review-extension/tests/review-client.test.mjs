import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBaseUrl,
  completionNotice,
  createReviewJob,
  fetchReviewJob,
} from "../src/reviewClient.ts";

test("uses the deployed Tencent Cloud Agent endpoint", () => {
  assert.equal(agentBaseUrl, "http://175.178.6.214:18110");
});

test("returns the existing partial and client-deadline notices", () => {
  assert.match(completionNotice({ status: "RUNNING" }), /60 秒/);
  assert.match(completionNotice({ status: "PARTIAL" }), /部分资料/);
  assert.equal(completionNotice({ status: "COMPLETED" }), "");
});

test("includes the HTTP status when job creation fails", async () => {
  const fetcher = async () => new Response(null, { status: 503 });

  await assert.rejects(() => createReviewJob({}, fetcher), /503/);
});

test("reports a missing job separately from other polling failures", async () => {
  const missingFetcher = async () => new Response(null, { status: 404 });
  const failedFetcher = async () => new Response(null, { status: 502 });

  await assert.rejects(() => fetchReviewJob("missing", missingFetcher), /可能已重启/);
  await assert.rejects(() => fetchReviewJob("failed", failedFetcher), /502/);
});
