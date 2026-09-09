import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("content collection accepts a manual business override", () => {
  const source = readFileSync(new URL("../public/content.js", import.meta.url), "utf8");

  assert.match(source, /message\.businessSelection/);
  assert.match(source, /ReviewBusinessDetector\.detect/);
  assert.match(source, /businessType/);
  assert.match(source, /selectionMode/);
});

test("side panel sends the selected business during collection", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const workflowSource = readFileSync(
    new URL("../src/hooks/useReviewWorkflow.ts", import.meta.url),
    "utf8",
  );
  const configSource = readFileSync(
    new URL("../src/reviewPanelConfig.ts", import.meta.url),
    "utf8",
  );

  assert.match(appSource, /businessSelection/);
  assert.match(appSource, /setBusinessSelection/);
  assert.match(configSource, /自动识别/);
  assert.match(workflowSource, /businessSelection/);
  assert.match(workflowSource, /setReview\(null\)/);
});

test("side panel renders exception sections derived from the agent response", () => {
  const source = readFileSync(
    new URL("../src/components/ReviewResults.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /exceptionSections\(review\.sections, review\.comparisons\)/);
  assert.match(source, /exceptionGroups\s*\.map/);
  assert.doesNotMatch(source, /title="报废车辆信息"/);
  assert.doesNotMatch(source, /title="新车及发票信息"/);
});

test("standalone preview reports that browser extension APIs are required", () => {
  const source = readFileSync(
    new URL("../src/hooks/useReviewWorkflow.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /请在浏览器扩展侧边栏中使用/);
  assert.match(source, /globalThis\.chrome\?\.tabs/);
});
