import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBaseUrl,
  completionNotice,
  createReviewJob,
  fetchReviewJob,
  localAgentBaseUrl,
  publicAgentBaseUrl,
  resolveAgentBaseUrl,
} from "../src/reviewClient.ts";

test("selects local and public Agent endpoints by build mode", () => {
  assert.equal(agentBaseUrl, localAgentBaseUrl);
  assert.equal(resolveAgentBaseUrl("development", undefined), localAgentBaseUrl);
  assert.equal(resolveAgentBaseUrl("public", undefined), publicAgentBaseUrl);
  assert.equal(
    resolveAgentBaseUrl("public", "http://example.test:9000/"),
    "http://example.test:9000",
  );
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
