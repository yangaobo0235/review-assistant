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

import {
  createScrapReplacementSession,
  isFieldFirstProfile,
} from "../src/hooks/useScrapReplacementReview.ts";

const require = createRequire(import.meta.url);
const cache = new Map();
function loadComponent(file) {
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
    return loadComponent(target);
  };
  vm.runInNewContext(output, { require: localRequire, module, exports: module.exports });
  return module.exports;
}
const { ScrapReplacementReview } = loadComponent(
  fileURLToPath(new URL("../src/components/ScrapReplacementReview.tsx", import.meta.url)),
);

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

const assistantMatch = makeStep({
  step_id: "RULE-POLICY-001",
  sequence: 1,
  label: "政策校验通过",
  reason: "政策校验通过，无需人工处理",
});

const pageConflict = makeStep({
  step_id: "FIELD-new_vehicle.vin",
  sequence: 2,
  category: "FIELD",
  display_target: "PAGE_FIELD",
  page_field: "new_vehicle.vin",
  requires_reviewer_action: true,
  label: "新车车架号",
  result_status: "CONFLICT",
  reason: "页面字段冲突：车架号与发票不一致",
});

const assistantInsufficient = makeStep({
  step_id: "MATERIAL-INVOICE-1",
  sequence: 3,
  category: "MATERIAL",
  requires_reviewer_action: true,
  label: "缺少新车发票",
  result_status: "INSUFFICIENT",
  reason: "缺少新车发票，请补齐后复核",
  values: [{ source: "新车材料所有人", value: "张三" }],
  evidence: [
    { source: "图片识别", image_id: "invoice-1" },
    { source: "图片识别", image_id: "invoice-1" },
    { source: "申请页面字段" },
  ],
});

const settle = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

function makeGateways(overrides = {}) {
  const calls = { show: [], complete: [], clear: [], fill: [] };
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
      applyFill: async (actions) => {
        calls.fill.push(actions);
        return overrides.applyFill?.(actions) ?? { ok: true, message: "挂靠字段已填写并回读" };
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
      return options.applyAffiliationFill
        ? options.applyAffiliationFill(actions)
        : { ok: true, message: "挂靠字段已填写并回读" };
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
    currentStepId: () => {
      const state = snapshots.at(-1)?.session;
      return state ? state.steps[state.index]?.step_id ?? null : null;
    },
  };
}

const decisionEvent = (stepId, decision = "CONFIRMED") => ({
  stepId,
  decision,
  pageInstanceId: pageData.pageInstanceId,
  collectionId: pageData.collectionId,
});

function renderAssistant(snapshot, onFocusImage = async () => {}) {
  return renderToStaticMarkup(
    React.createElement(ScrapReplacementReview, {
      assistantStep: snapshot?.assistantStep ?? null,
      blockingIssue: snapshot?.blockingIssue ?? null,
      onDecide: () => {},
      onFocusImage,
    }),
  );
}

/** 跑完编排后渲染助手：页面异常步骤由模拟的 Content Script 事件放行。 */
async function renderReview(steps, options = {}) {
  const runner = runSession(steps, options);
  runner.session.start();
  await settle();
  const latest = runner.latest();
  const waiting = latest?.session.steps[latest.session.index];
  if (waiting?.display_target === "PAGE_FIELD" && waiting.requires_reviewer_action) {
    runner.gateways.emit(decisionEvent(waiting.step_id));
    await settle();
  }
  return { ...runner, html: renderAssistant(runner.latest()) };
}

test("only Qingdao and Changchun scrap profiles use field-first review", () => {
  const qingdaoReview = { business_type: "scrap_replacement", region: "qingdao", profile_version: "1.0" };
  const changchunReview = { business_type: "scrap_replacement", region: "changchun", profile_version: "1.0" };
  const transferReview = { business_type: "transfer", region: "qingdao", profile_version: "1.0" };

  assert.equal(isFieldFirstProfile(qingdaoReview), true);
  assert.equal(isFieldFirstProfile(changchunReview), true);
  assert.equal(isFieldFirstProfile(transferReview), false);
  assert.equal(isFieldFirstProfile({ business_type: "scrap_replacement", region: "default", profile_version: "1.0" }), false);
  assert.equal(isFieldFirstProfile({ business_type: "scrap_replacement", region: "qingdao", profile_version: "2.0" }), false);
  assert.equal(isFieldFirstProfile({ business_type: "consistency", region: "changchun", profile_version: "1.0" }), false);
});

test("assistant renders only the current actionable ASSISTANT step", async () => {
  const { html } = await renderReview([assistantMatch, pageConflict, assistantInsufficient]);

  assert.doesNotMatch(html, /政策校验通过/);
  assert.doesNotMatch(html, /页面字段冲突/);
  assert.match(html, /缺少新车发票/);
  assert.match(html, /确认无误/);
  assert.match(html, /标记异常/);
  assert.doesNotMatch(html, /继续|审核汇总|最终建议|重试次数/);
});

test("assistant item shows backend values and a deduplicated original-image action", async () => {
  const { html } = await renderReview([assistantInsufficient]);

  assert.match(html, /新车材料所有人/);
  assert.match(html, /张三/);
  assert.equal(html.match(/查看原图/g).length, 1);
});

test("assistant renders the blocking issue without any decision buttons", () => {
  const html = renderAssistant({ assistantStep: null, blockingIssue: "页面已变化，请重新审核" });

  assert.match(html, /页面已变化，请重新审核/);
  assert.doesNotMatch(html, /确认无误|标记异常/);
});

test("assistant renders nothing when no item needs the reviewer", async () => {
  const { html, latest } = await renderReview([assistantMatch]);

  assert.equal(latest().session.phase, "COMPLETED");
  assert.equal(html, "");
});
