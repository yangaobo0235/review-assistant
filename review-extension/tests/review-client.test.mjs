import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBaseUrl,
  completionNotice,
  completeStreamReviewJob,
  createStreamReviewJob,
  fetchReviewJob,
  localAgentBaseUrl,
  publicAgentBaseUrl,
  resolveAgentBaseUrl,
  uploadStreamReviewImage,
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
  assert.match(completionNotice({ status: "RUNNING" }), /120 秒/);
  assert.match(completionNotice({ status: "PARTIAL" }), /部分资料/);
  assert.equal(completionNotice({ status: "COMPLETED" }), "");
});

test("creates a stream job from metadata without embedding image payloads", async () => {
  let requestBody;
  const fetcher = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ job_id: "job-1", status: "RUNNING", created_at: "" }));
  };

  await createStreamReviewJob({
    pageUrl: "https://example.test/review",
    images: [{ index: 0, imageId: "image-0", src: "data:image/jpeg;base64,AA==", dataUrl: "data:image/jpeg;base64,AA==" }],
  }, fetcher);

  assert.equal(requestBody.images[0].dataUrl, null);
  assert.equal(requestBody.images[0].src, "");
});

test("uploads one stream image as multipart binary and completes the upload", async () => {
  const requests = [];
  const snapshot = {
    job_id: "job-1",
    status: "RUNNING",
    created_at: "",
    progress: { total_count: 1, uploaded_count: 1, completed_count: 0, failed_count: 0, timed_out_count: 0 },
    groups: {},
  };
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(snapshot));
  };

  await uploadStreamReviewImage("job-1", {
    index: 0,
    imageId: "image-0",
    dataUrl: "data:image/jpeg;base64,AA==",
    collectionError: null,
  }, fetcher);
  await completeStreamReviewJob("job-1", fetcher);

  const form = requests[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(JSON.parse(form.get("metadata")).dataUrl, null);
  assert.ok(form.get("file") instanceof Blob);
  assert.match(requests[0].url, /\/jobs\/job-1\/images$/);
  assert.equal(requests[1].init.method, "POST");
  assert.match(requests[1].url, /\/jobs\/job-1\/complete$/);
});

test("includes the HTTP status when job creation fails", async () => {
  const fetcher = async () => new Response(null, { status: 503 });

  await assert.rejects(() => createStreamReviewJob({ images: [] }, fetcher), /503/);
});

test("reports a missing job separately from other polling failures", async () => {
  const missingFetcher = async () => new Response(null, { status: 404 });
  const failedFetcher = async () => new Response(null, { status: 502 });

  await assert.rejects(() => fetchReviewJob("missing", missingFetcher), /可能已重启/);
  await assert.rejects(() => fetchReviewJob("failed", failedFetcher), /502/);
});
