import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { createScrapReplacementSession } from "../src/hooks/useScrapReplacementReview.ts";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const require = createRequire(import.meta.url);
const cache = new Map();
function loadModule(file, extraGlobals = {}) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    let target = path.resolve(path.dirname(file), specifier);
    if (!path.extname(target)) target = [".ts", ".tsx"].map((extension) => target + extension).find(existsSync);
    return loadModule(target, extraGlobals);
  };
  vm.runInNewContext(output, {
    console,
    setTimeout,
    clearTimeout,
    ...extraGlobals,
    require: localRequire,
    module,
    exports: module.exports,
  });
  return module.exports;
}

const pageData = {
  pageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1",
  sourceTabId: 42,
  pageInstanceId: "page-instance",
  pageFingerprint: '[["application.id","case-a"]]',
  collectionId: "collection-1",
};

const makeStep = (overrides) => ({
  sequence: 1,
  category: "BUSINESS_RULE",
  display_target: "ASSISTANT",
  page_field: null,
  requires_reviewer_action: false,
  label: "审核步骤",
  result_status: "MATCH",
  reason: "",
  values: [],
  evidence: [],
  ...overrides,
});

const pageMatch = (stepId, sequence) => makeStep({
  step_id: stepId,
  sequence,
  category: "FIELD",
  display_target: "PAGE_FIELD",
  page_field: stepId,
  label: stepId,
});

const assistantConflict = (stepId, sequence, label = stepId) => makeStep({
  step_id: stepId,
  sequence,
  label,
  result_status: "CONFLICT",
  reason: `${label}存在冲突`,
  requires_reviewer_action: true,
});

const SUBJECT_STEP_ID = "BUSINESS-AFFILIATION-SUBJECT-001";
const GUARD_STEP_IDS = [
  "BUSINESS-AFFILIATION-AUX-OWNER-TYPE",
  "BUSINESS-AFFILIATION-AUX-NEW-VIN",
  "BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME",
];

const affiliationSteps = ({ subjectStatus = "MATCH", guardStatuses = {} } = {}) => [
  makeStep({
    step_id: SUBJECT_STEP_ID,
    sequence: 1,
    label: "新旧车主体关系检查",
    result_status: subjectStatus,
    requires_reviewer_action: subjectStatus !== "MATCH",
    reason: "主体关系结论",
  }),
  ...GUARD_STEP_IDS.map((stepId, index) => {
    const status = guardStatuses[stepId] ?? "MATCH";
    return makeStep({
      step_id: stepId,
      sequence: 2 + index,
      category: "BUSINESS_RULE",
      display_target: "ASSISTANT",
      result_status: status,
      requires_reviewer_action: status !== "MATCH",
      label: `保护项 ${index + 1}`,
    });
  }),
];

const affiliationIntent = [
  { field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "COMPANY" },
  { field: "new_vehicle.affiliation", target_label: "新车挂靠", owner_type: "COMPANY" },
];

const settle = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

function makeGateways(overrides = {}) {
  const calls = { show: [], complete: [], clear: [] };
  const listeners = new Set();
  return {
    calls,
    listenerCount: () => listeners.size,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    api: {
      show: async (step) => {
        calls.show.push(step.step_id);
        return overrides.show?.(step) ?? { ok: true };
      },
      complete: async (stepId) => {
        calls.complete.push(stepId);
        return overrides.complete?.(stepId) ?? { ok: true };
      },
      clear: async () => {
        calls.clear.push(true);
        return overrides.clear?.() ?? { ok: true };
      },
      subscribe: (_context, onDecision) => {
        listeners.add(onDecision);
        return () => listeners.delete(onDecision);
      },
    },
  };
}

function runSession(steps, options = {}) {
  const gateways = makeGateways(options.gateways);
  const snapshots = [];
  const fills = [];
  const session = createScrapReplacementSession({
    steps,
    pageData,
    sessionKey: "test-session",
    getPageFillIntent: () => options.pageFillIntent ?? [],
    applyAffiliationFill: async (actions) => {
      fills.push(actions);
      return options.fillResult ?? { ok: true, message: "挂靠字段已填写并回读" };
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    gateways: gateways.api,
  });
  return {
    session,
    gateways,
    snapshots,
    fills,
    latest: () => snapshots.at(-1) ?? null,
  };
}

const decisionEvent = (stepId, decision = "CONFIRMED", overrides = {}) => ({
  stepId,
  decision,
  pageInstanceId: pageData.pageInstanceId,
  collectionId: pageData.collectionId,
  ...overrides,
});

test("page match shows its marker and auto-advances without any COMPLETE message", async () => {
  const runner = runSession([pageMatch("FIELD-a", 1), pageMatch("FIELD-b", 2)]);

  runner.session.start();
  await settle();

  assert.deepEqual(runner.gateways.calls.show, ["FIELD-a", "FIELD-b"]);
  assert.deepEqual(runner.gateways.calls.complete, []);
  assert.equal(runner.latest().session.phase, "COMPLETED");
  assert.ok(runner.snapshots.every((snapshot) => snapshot.assistantStep === null));
});

test("page conflict waits for the content-script decision, freezes the marker, then advances", async () => {
  const conflict = makeStep({
    step_id: "FIELD-new_vehicle.vin",
    sequence: 1,
    category: "FIELD",
    display_target: "PAGE_FIELD",
    page_field: "new_vehicle.vin",
    label: "新车车架号",
    result_status: "CONFLICT",
    requires_reviewer_action: true,
  });
  const runner = runSession([conflict, pageMatch("FIELD-b", 2)]);

  runner.session.start();
  await settle();
  assert.equal(runner.latest().session.phase, "WAITING_REVIEWER");
  assert.equal(runner.latest().assistantStep, null);
  assert.deepEqual(runner.gateways.calls.complete, []);

  // 过期/无关事件被忽略。
  runner.gateways.emit(decisionEvent("FIELD-other"));
  await settle();
  assert.deepEqual(runner.gateways.calls.complete, []);

  runner.gateways.emit(decisionEvent(conflict.step_id, "MARKED_EXCEPTION"));
  await settle();

  assert.deepEqual(runner.gateways.calls.complete, [conflict.step_id]);
  assert.equal(runner.latest().session.phase, "COMPLETED");
  assert.equal(runner.latest().session.decisions[conflict.step_id], "MARKED_EXCEPTION");
  // 后端结论不被人工选择篡改。
  assert.equal(conflict.result_status, "CONFLICT");
});

test("a refused show becomes the blocking issue and stops all further marking", async () => {
  const refusal = { ok: false, error: "页面已变化，请重新审核" };
  const runner = runSession(
    [pageMatch("FIELD-a", 1), pageMatch("FIELD-b", 2), pageMatch("FIELD-c", 3)],
    { gateways: { show: (step) => (step.step_id === "FIELD-b" ? refusal : { ok: true }) } },
  );

  runner.session.start();
  await settle();

  assert.deepEqual(runner.gateways.calls.show, ["FIELD-a", "FIELD-b"]);
  assert.equal(runner.latest().session.phase, "STALE_PAGE");
  assert.equal(runner.latest().blockingIssue, refusal.error);
  assert.equal(runner.fills.length, 0);
});

test("assistant match advances silently while assistant exceptions wait for the panel button", async () => {
  const match = makeStep({ step_id: "RULE-1", sequence: 1, label: "政策规则" });
  const conflict = assistantConflict("RULE-2", 2, "发票校验");
  const runner = runSession([match, conflict]);

  runner.session.start();
  await settle();

  assert.deepEqual(runner.gateways.calls.show, []);
  assert.equal(runner.latest().session.phase, "WAITING_REVIEWER");
  assert.equal(runner.latest().assistantStep.step_id, conflict.step_id);
  assert.ok(runner.snapshots.every((snapshot) => snapshot.assistantStep?.step_id !== match.step_id));
});

test("each assistant button records the decision and advances in one click", async () => {
  const first = assistantConflict("RULE-1", 1, "发票校验");
  const second = assistantConflict("RULE-2", 2, "登记证书校验");
  const runner = runSession([first, second]);

  runner.session.start();
  await settle();
  assert.equal(runner.latest().assistantStep.step_id, first.step_id);

  // 不是当前步骤的旧按钮无效。
  runner.session.decide(second.step_id, "CONFIRMED");
  await settle();
  assert.equal(runner.latest().assistantStep.step_id, first.step_id);

  runner.session.decide(first.step_id, "CONFIRMED");
  await settle();
  // 一次点击立即进入下一项，没有额外的“继续”。
  assert.equal(runner.latest().assistantStep.step_id, second.step_id);
  assert.equal(runner.latest().session.decisions[first.step_id], "CONFIRMED");

  runner.session.decide(second.step_id, "MARKED_EXCEPTION");
  await settle();
  assert.equal(runner.latest().session.phase, "COMPLETED");
  assert.deepEqual(runner.latest().session.decisions, {
    "RULE-1": "CONFIRMED",
    "RULE-2": "MARKED_EXCEPTION",
  });
});

test("affiliation fill runs exactly once after subject and all three protections MATCH", async () => {
  const runner = runSession(affiliationSteps(), { pageFillIntent: affiliationIntent });

  runner.session.start();
  await settle();

  assert.equal(runner.fills.length, 1);
  assert.deepEqual(runner.fills[0], affiliationIntent);
  assert.equal(runner.latest().session.phase, "COMPLETED");
  assert.equal(runner.latest().blockingIssue, null);
  // 成功填写不形成常驻卡片：从未暴露助手事项。
  assert.ok(runner.snapshots.every((snapshot) => snapshot.assistantStep === null));
});

test("no fill when any protection step is not MATCH", async () => {
  const runner = runSession(
    affiliationSteps({ guardStatuses: { "BUSINESS-AFFILIATION-AUX-NEW-VIN": "CONFLICT" } }),
    { pageFillIntent: affiliationIntent },
  );

  runner.session.start();
  await settle();

  assert.equal(runner.fills.length, 0);
  // 主体关系静默通过，冲突保护项成为当前助手事项。
  assert.equal(runner.latest().assistantStep.step_id, "BUSINESS-AFFILIATION-AUX-NEW-VIN");
});

test("no fill when the backend returned no page fill intent", async () => {
  const runner = runSession(affiliationSteps(), { pageFillIntent: [] });

  runner.session.start();
  await settle();

  assert.equal(runner.fills.length, 0);
  assert.equal(runner.latest().session.phase, "COMPLETED");
});

test("a CONFLICT subject relation never fills and becomes the assistant item", async () => {
  const runner = runSession(affiliationSteps({ subjectStatus: "CONFLICT" }), {
    pageFillIntent: affiliationIntent,
  });

  runner.session.start();
  await settle();
  assert.equal(runner.fills.length, 0);
  assert.equal(runner.latest().assistantStep.step_id, SUBJECT_STEP_ID);

  runner.session.decide(SUBJECT_STEP_ID, "MARKED_EXCEPTION");
  await settle();
  assert.equal(runner.fills.length, 0);
  assert.equal(runner.latest().session.phase, "COMPLETED");
});

test("fill failure becomes the blocking issue, is never retried, and stops later steps", async () => {
  const failure = { ok: false, message: "新车挂靠写入失败，已回滚未完成" };
  const steps = [...affiliationSteps(), pageMatch("FIELD-after", 9)];
  const runner = runSession(steps, { pageFillIntent: affiliationIntent, fillResult: failure });

  runner.session.start();
  await settle();

  assert.equal(runner.fills.length, 1);
  assert.equal(runner.latest().session.phase, "STALE_PAGE");
  assert.equal(runner.latest().blockingIssue, failure.message);
  assert.equal(runner.latest().assistantStep, null);
  // 失效后不再执行任何后续标记。
  assert.deepEqual(runner.gateways.calls.show, []);
});

test("dispose unsubscribes and clears markers; a refused clear is surfaced and the old session stops", async () => {
  const conflict = assistantConflict("RULE-1", 1, "发票校验");
  const ok = runSession([conflict]);
  ok.session.start();
  await settle();
  assert.equal(ok.gateways.listenerCount(), 1);

  const cleared = await ok.session.dispose();
  assert.deepEqual(cleared, { ok: true });
  assert.equal(ok.gateways.listenerCount(), 0);
  assert.equal(ok.gateways.calls.clear.length, 1);

  // 旧会话已停止：按钮与页面事件都不再生效。
  const before = ok.snapshots.length;
  ok.session.decide(conflict.step_id, "CONFIRMED");
  ok.gateways.emit(decisionEvent(conflict.step_id));
  await settle();
  assert.equal(ok.snapshots.length, before);

  const refusal = { ok: false, error: "页面已变化，请重新审核" };
  const refused = runSession([conflict], { gateways: { clear: () => refusal } });
  refused.session.start();
  await settle();
  assert.deepEqual(await refused.session.dispose(), refusal);
});

test("startReview itself never sends APPLY_PAGE_FILL_INTENT for a finished job carrying a fill intent", async () => {
  const messages = [];
  const collectedPage = {
    pageUrl: pageData.pageUrl,
    pageInstanceId: pageData.pageInstanceId,
    pageFingerprint: pageData.pageFingerprint,
    collectionId: pageData.collectionId,
    pageTitle: "报废置换审核",
    pageFields: {},
    pageText: "",
    images: [],
    businessType: "scrap_replacement",
    region: "qingdao",
    profileVersion: "1.0",
  };
  const finishedResult = {
    business_type: "scrap_replacement",
    region: "qingdao",
    profile_version: "1.0",
    recommendation: "REVIEW_REQUIRED",
    risk_level: "MEDIUM",
    summary: "审核完成",
    comparisons: [],
    qr_checks: [],
    cross_checks: [],
    issues: [],
    sections: [],
    page_fill_intent: affiliationIntent,
    review_steps: [],
  };
  const chromeStub = {
    tabs: {
      query: async () => [{ id: 42 }],
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        if (message.type === "COLLECT_PAGE_DATA") return collectedPage;
        return { ok: true };
      },
    },
  };
  const fetchStub = async (url, init) => {
    if (String(url).endsWith("/api/review/jobs") && init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ job_id: "job-1", status: "RUNNING", created_at: "" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        job_id: "job-1",
        status: "COMPLETED",
        created_at: "",
        progress: { total_count: 1, completed_count: 1, failed_count: 0, timed_out_count: 0 },
        groups: {},
        result: finishedResult,
      }),
    };
  };

  const { useReviewWorkflow } = loadModule(
    fileURLToPath(new URL("../src/hooks/useReviewWorkflow.ts", import.meta.url)),
    { chrome: chromeStub, fetch: fetchStub, window: { setTimeout, clearTimeout } },
  );

  let captured = null;
  function Harness() {
    captured = useReviewWorkflow("AUTO");
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  await captured.startReview();

  assert.ok(messages.some(({ message }) => message.type === "COLLECT_PAGE_DATA"));
  assert.ok(
    !messages.some(({ message }) => message.type === "APPLY_PAGE_FILL_INTENT"),
    "startReview must not auto-fill; the fill belongs to the affiliation gate",
  );
});

test("ReviewResults routes only field-first profiles to the minimal assistant and keeps the legacy JSX", () => {
  const source = read("../src/components/ReviewResults.tsx");

  assert.match(source, /isFieldFirstProfile\(review\)/);
  assert.match(source, /<ScrapReplacementReview/);
  assert.match(source, /function LegacyReviewResults/);
  assert.match(source, /<LegacyReviewResults/);
  // 过户、车源和一致性继续使用现有结果界面和行为。
  const legacy = source.slice(source.indexOf("function LegacyReviewResults"));
  assert.match(legacy, /<ReviewFieldStepper/);
  assert.match(legacy, /<ReviewAdvice review=\{review\} \/>/);
  assert.match(legacy, /<MaterialCompleteness/);
});

test("the field-first assistant never renders legacy summary sections", () => {
  const source = read("../src/components/ScrapReplacementReview.tsx");

  assert.doesNotMatch(
    source,
    /ReviewAdvice|MaterialCompleteness|QrResults|exceptionComparisons|exceptionSections|ReviewFieldStepper|pageFillResult|逐项审核|审核汇总|最终建议/,
  );
  assert.match(source, /确认无误/);
  assert.match(source, /标记异常/);
  assert.match(source, /查看原图/);
});

test("App composes the orchestration hook and surfaces the cleanup notice", () => {
  const source = read("../src/App.tsx");

  assert.match(source, /useScrapReplacementReview\(workflow\)/);
  assert.match(source, /scrapReview=\{scrapReview\}/);
  assert.match(source, /scrapReview\.notice/);
});

test("the orchestration hook keys the affiliation gate off stable backend step ids", () => {
  const source = read("../src/hooks/useScrapReplacementReview.ts");

  assert.match(source, /BUSINESS-AFFILIATION-SUBJECT-001/);
  assert.match(source, /BUSINESS-AFFILIATION-AUX-OWNER-TYPE/);
  assert.match(source, /BUSINESS-AFFILIATION-AUX-NEW-VIN/);
  assert.match(source, /BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME/);
  // 绝不通过中文 label 识别步骤。
  assert.doesNotMatch(source, /新旧车挂靠主体关系|车辆所有人类型|OCR新车车架号|客户名称/);
  // 生命周期：清理标记、取消订阅、失败提示刷新。
  assert.match(source, /clearPageReviewMarkers/);
  assert.match(source, /subscribePageReviewDecisions/);
  assert.match(source, /请刷新页面/);
});

test("assistant styles keep stable button heights, focus states, and wrapping", () => {
  const css = read("../src/App.css");

  assert.match(css, /\.assistant-review-actions button \{[^}]*min-height/s);
  assert.match(css, /\.assistant-review-actions button:focus-visible \{[^}]*outline/s);
  assert.match(css, /\.assistant-review-reason \{[^}]*overflow-wrap/s);
  assert.doesNotMatch(css, /font-size:[^;]*v[wmin]/);
});
