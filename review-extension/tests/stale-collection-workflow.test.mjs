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

test("startReview surfaces the stale-collection reason instead of the business-detection fallback", async () => {
  const jobPosts = [];
  const thrownMessages = [];
  class RecordingError extends Error {
    constructor(message) {
      super(message);
      thrownMessages.push(message);
    }
  }
  const stalePage = {
    pageUrl: "https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1",
    pageInstanceId: "page-instance",
    pageFingerprint: '[["application.id","case-a"]]',
    collectionId: "stale-collection",
    pageTitle: "报废置换审核",
    pageFields: {},
    pageText: "",
    images: [],
    businessType: "scrap_replacement",
    region: "qingdao",
    profileVersion: "1.0",
    staleCollection: true,
    collectionIssues: ["页面采集已过期，请重新采集"],
  };
  const chromeStub = {
    tabs: {
      query: async () => [{ id: 42 }],
      sendMessage: async (tabId, message) =>
        message.type === "COLLECT_PAGE_MANIFEST" ? stalePage : { ok: true },
    },
  };
  const fetchStub = async (url, init) => {
    if (String(url).endsWith("/api/review/jobs") && init?.method === "POST") {
      jobPosts.push(String(url));
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const { useReviewWorkflow } = loadModule(
    fileURLToPath(new URL("../src/hooks/useReviewWorkflow.ts", import.meta.url)),
    {
      chrome: chromeStub,
      fetch: fetchStub,
      window: { setTimeout, clearTimeout },
      Error: RecordingError,
    },
  );

  let captured = null;
  function Harness() {
    captured = useReviewWorkflow("AUTO");
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  await captured.startReview();

  // 被取代的采集不得继续创建审核任务……
  assert.deepEqual(jobPosts, []);
  // ……并且面板透出真实原因，而不是“无法识别当前审核业务，请人工选择”。
  assert.deepEqual(thrownMessages, ["页面采集已过期，请重新采集"]);
});
