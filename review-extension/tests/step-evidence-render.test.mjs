import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
const { ReviewFieldStepper } = loadComponent(fileURLToPath(new URL("../src/components/ReviewFieldStepper.tsx", import.meta.url)));
function renderEvidence(evidence, category = "FIELD") {
  return renderToStaticMarkup(React.createElement(ReviewFieldStepper, {
    onFocusImage: async () => {},
    reviewSteps: [{ step_id: "test", sequence: 1, category, label: "证据核验", result_status: "INSUFFICIENT", reason: "请检查证据", values: [], evidence }],
  }));
}

test("uncertain evidence keeps its raw value visibly marked for manual confirmation", () => {
  const html = renderEvidence([{ source: "图片识别", value: "张三", uncertain: true }]);
  assert.match(html, /张三/);
  assert.match(html, /不确定.*待人工确认/);
  assert.doesNotMatch(renderEvidence([{ source: "图片识别", value: "张三", uncertain: false }]), /不确定.*待人工确认/);
});

test("QR external evidence renders its original image action and provenance", () => {
  const html = renderEvidence([{ source: "二维码官网字段", source_id: "scrap-04", image_id: "scrap-04", document_type: "scrap_certificate", value: { vin: "VIN1" } }], "EXTERNAL");
  assert.match(html, /查看原图/);
  assert.match(html, /scrap-04/);
  assert.match(html, /报废证明/);
  assert.doesNotMatch(renderEvidence([{ source: "二维码官网字段" }], "EXTERNAL"), /查看原图/);
});
