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

import { createAffiliationFillLatch } from "../src/hooks/useScrapReplacementReview.ts";
import {
  decisionEvent,
  makeStep,
  pageData,
  runSession,
  settle,
} from "./helpers/scrapReplacementHarness.mjs";

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

/** 在测试体内监听未处理拒绝：任何编排路径都不得泄漏 rejection。 */
function watchUnhandledRejections(t) {
  const rejections = [];
  const onUnhandledRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  t.after(() => process.off("unhandledRejection", onUnhandledRejection));
  return rejections;
}

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

test("a thrown show rejection becomes the blocking issue without an unhandled rejection", async (t) => {
  const rejections = watchUnhandledRejections(t);
  const runner = runSession([pageMatch("FIELD-a", 1), pageMatch("FIELD-b", 2)], {
    gateways: {
      show: (step) => {
        // sendMessage 在标签页导航/关闭或上下文失效时直接 reject。
        if (step.step_id === "FIELD-b") {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { ok: true };
      },
    },
  });

  runner.session.start();
  await settle();
  await settle();

  assert.deepEqual(runner.gateways.calls.show, ["FIELD-a", "FIELD-b"]);
  assert.equal(runner.latest().session.phase, "STALE_PAGE");
  assert.match(runner.latest().blockingIssue, /Could not establish connection/);
  assert.equal(runner.fills.length, 0);
  assert.deepEqual(rejections, []);
});

test("a thrown complete rejection freezes the session as STALE_PAGE", async (t) => {
  const rejections = watchUnhandledRejections(t);
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
  const runner = runSession([conflict, pageMatch("FIELD-b", 2)], {
    gateways: { complete: () => { throw new Error("消息端口已关闭"); } },
  });

  runner.session.start();
  await settle();
  assert.equal(runner.latest().session.phase, "WAITING_REVIEWER");

  runner.gateways.emit(decisionEvent(conflict.step_id, "CONFIRMED"));
  await settle();
  await settle();

  assert.equal(runner.latest().session.phase, "STALE_PAGE");
  assert.match(runner.latest().blockingIssue, /消息端口已关闭/);
  // 冻结被拒绝后不再执行任何后续标记。
  assert.deepEqual(runner.gateways.calls.show, ["FIELD-new_vehicle.vin"]);
  assert.deepEqual(rejections, []);
});

test("a thrown fill rejection becomes the blocking issue and is never retried", async (t) => {
  const rejections = watchUnhandledRejections(t);
  const runner = runSession([...affiliationSteps(), pageMatch("FIELD-after", 9)], {
    pageFillIntent: affiliationIntent,
    applyAffiliationFill: async () => {
      throw new Error("Extension context invalidated.");
    },
  });

  runner.session.start();
  await settle();
  await settle();

  assert.equal(runner.fills.length, 1);
  assert.equal(runner.latest().session.phase, "STALE_PAGE");
  assert.match(runner.latest().blockingIssue, /Extension context invalidated/);
  assert.equal(runner.latest().assistantStep, null);
  assert.deepEqual(runner.gateways.calls.show, []);
  assert.deepEqual(rejections, []);
});

test("a thrown clear rejection surfaces from dispose as a cleanup failure", async (t) => {
  const rejections = watchUnhandledRejections(t);
  const runner = runSession([assistantConflict("RULE-1", 1, "发票校验")], {
    gateways: { clear: () => { throw new Error("No tab with id: 42."); } },
  });
  runner.session.start();
  await settle();

  const cleared = await runner.session.dispose();

  assert.equal(cleared.ok, false);
  assert.match(cleared.error, /No tab with id/);
  assert.equal(runner.gateways.listenerCount(), 0);
  assert.deepEqual(rejections, []);
});

test("the fill latch survives a session rebuild within one collection", async () => {
  const latch = createAffiliationFillLatch();
  const first = runSession(affiliationSteps(), {
    pageFillIntent: affiliationIntent,
    affiliationFillLatch: latch,
  });
  first.session.start();
  await settle();
  assert.equal(first.fills.length, 1);
  assert.equal(first.latest().session.phase, "COMPLETED");

  // 轮询导致 stepsKey 变化 → hook 重建会话；同一采集 ID 绝不允许第二次写入。
  const rebuilt = runSession(affiliationSteps(), {
    pageFillIntent: affiliationIntent,
    affiliationFillLatch: latch,
  });
  rebuilt.session.start();
  await settle();
  assert.equal(rebuilt.fills.length, 0);
  assert.equal(rebuilt.latest().session.phase, "COMPLETED");
  assert.equal(rebuilt.latest().blockingIssue, null);

  // 全新一轮审核（新采集 ID）允许再执行一次写入。
  const fresh = runSession(affiliationSteps(), {
    pageFillIntent: affiliationIntent,
    affiliationFillLatch: latch,
    pageData: { ...pageData, collectionId: "collection-2" },
  });
  fresh.session.start();
  await settle();
  assert.equal(fresh.fills.length, 1);
});

test("disposing mid-fill still latches the collection against a second write", async () => {
  const latch = createAffiliationFillLatch();
  let releaseFill;
  const pendingFill = new Promise((resolve) => { releaseFill = resolve; });
  const first = runSession(affiliationSteps(), {
    pageFillIntent: affiliationIntent,
    affiliationFillLatch: latch,
    applyAffiliationFill: () => pendingFill,
  });
  first.session.start();
  await settle();
  assert.equal(first.fills.length, 1);

  await first.session.dispose();
  releaseFill({ ok: true, message: "挂靠字段已填写并回读" });
  await settle();

  const rebuilt = runSession(affiliationSteps(), {
    pageFillIntent: affiliationIntent,
    affiliationFillLatch: latch,
  });
  rebuilt.session.start();
  await settle();
  assert.equal(rebuilt.fills.length, 0);
  assert.equal(rebuilt.latest().session.phase, "COMPLETED");
});

test("an intent that does not exactly cover both affiliation fields blocks without filling", async () => {
  const malformedShapes = [
    [affiliationIntent[0]],
    [affiliationIntent[1]],
    [affiliationIntent[0], { ...affiliationIntent[0] }],
    [
      ...affiliationIntent,
      { field: "old_vehicle.affiliation", target_label: "多余动作", owner_type: "COMPANY" },
    ],
    [
      { field: "new_vehicle.owner_name", target_label: "陌生字段", owner_type: "COMPANY" },
      { field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "COMPANY" },
    ],
  ];
  for (const intent of malformedShapes) {
    const runner = runSession(affiliationSteps(), { pageFillIntent: intent });
    runner.session.start();
    await settle();

    assert.equal(runner.fills.length, 0);
    assert.equal(runner.latest().session.phase, "STALE_PAGE");
    assert.match(runner.latest().blockingIssue, /挂靠填写意图字段异常/);
    assert.equal(runner.latest().assistantStep, null);
  }
});

test("fill proceeds when the intent covers both affiliation fields in either order", async () => {
  const runner = runSession(affiliationSteps(), {
    pageFillIntent: [...affiliationIntent].reverse(),
  });

  runner.session.start();
  await settle();

  assert.equal(runner.fills.length, 1);
  assert.equal(runner.latest().session.phase, "COMPLETED");
  assert.equal(runner.latest().blockingIssue, null);
});

test("a MATCH protection step that still requires reviewer action blocks the fill", async () => {
  const steps = affiliationSteps();
  const ownerTypeIndex = steps.findIndex(
    (step) => step.step_id === "BUSINESS-AFFILIATION-AUX-OWNER-TYPE",
  );
  // 后端不一致载荷：result_status 是 MATCH 却仍要求人工处理。
  steps[ownerTypeIndex] = { ...steps[ownerTypeIndex], requires_reviewer_action: true };
  const runner = runSession(steps, { pageFillIntent: affiliationIntent });

  runner.session.start();
  await settle();

  assert.equal(runner.fills.length, 0);
  assert.notEqual(runner.latest().session.phase, "STALE_PAGE");
  assert.equal(
    runner.latest().assistantStep.step_id,
    "BUSINESS-AFFILIATION-AUX-OWNER-TYPE",
  );
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
  // 逐项审核 stepper 已整体退役：旧业务结果界面不得再出现它的任何痕迹。
  assert.doesNotMatch(source, /ReviewFieldStepper/);
  assert.doesNotMatch(legacy, /逐项审核|review_steps/);
  assert.match(legacy, /<ReviewAdvice review=\{review\} \/>/);
  assert.match(legacy, /<MaterialCompleteness/);
  assert.ok(!existsSync(fileURLToPath(new URL("../src/components/ReviewFieldStepper.tsx", import.meta.url))));
});

test("the field-first assistant never renders legacy summary sections", () => {
  const source = read("../src/components/ScrapReplacementReview.tsx");

  assert.doesNotMatch(
    source,
    /ReviewAdvice|<MaterialCompleteness|QrResults|exceptionComparisons|exceptionSections|ReviewFieldStepper|pageFillResult|逐项审核|审核汇总|最终建议/,
  );
  assert.match(source, /确认无误/);
  assert.match(source, /标记异常/);
  assert.match(source, /查看原图/);
  assert.match(source, /automaticAttempt/);
  assert.match(source, /onApplyAffiliationFill\(actions\)/);
  assert.match(source, /正在联合校验并填写挂靠字段/);
});

test("App renders the workbench without starting the retired page-marker orchestration", () => {
  const source = read("../src/App.tsx");

  assert.doesNotMatch(source, /useScrapReplacementReview\(workflow\)/);
  assert.doesNotMatch(source, /scrapReview=\{scrapReview\}|scrapReview\.notice/);
  assert.match(source, /onApplyPageFieldValue=\{workflow\.applyPageFieldValue\}/);
  assert.match(source, /onRerun=\{workflow\.startReview\}/);
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

test("the hook hardens transport rejections, the fill latch, and generation-scoped cleanup notices", () => {
  const source = read("../src/hooks/useScrapReplacementReview.ts");

  // 每个网关调用点都包 try/catch：show、complete、clear、fill 加 pump 兜底。
  assert.ok(source.split("catch").length - 1 >= 5, "expected try/catch around every gateway call site");
  // 一次性写入闸门在 hook 层持有（按采集 ID 键控），会话重建不重置。
  assert.match(source, /createAffiliationFillLatch/);
  assert.match(source, /affiliationFillLatch: fillLatch/);
  // 清理通知按代号作用域：已销毁旧会话不得覆盖新会话的通知状态。
  assert.match(source, /generationRef\.current === generation/);
  // dispose().then 带拒绝分支，绝不产生未处理拒绝。
  assert.match(source, /notifyCleanupFailure/);
});

test("assistant styles keep stable button heights, focus states, and wrapping", () => {
  const css = read("../src/App.css");

  assert.match(css, /\.assistant-review-actions button \{[^}]*min-height/s);
  assert.match(css, /\.assistant-review-actions button:focus-visible \{[^}]*outline/s);
  assert.match(css, /\.assistant-review-reason \{[^}]*overflow-wrap/s);
  assert.doesNotMatch(css, /font-size:[^;]*v[wmin]/);
});
