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

import { isFieldFirstProfile } from "../src/hooks/useScrapReplacementReview.ts";
import {
  decisionEvent,
  makeStep,
  runSession,
  settle,
} from "./helpers/scrapReplacementHarness.mjs";

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

function workbenchReview(reviewSteps, overrides = {}) {
  return {
    business_type: "scrap_replacement",
    region: "changchun",
    profile_version: "1.0",
    review_steps: reviewSteps,
    qr_checks: [],
    page_fill_intent: [],
    material_completeness: { phase: "EXTRACTED", status: "COMPLETE", enforced: false, issues: [] },
    ...overrides,
  };
}

test("manual input defaults to the page value below material candidates on every field card", () => {
  for (const name of ["scrap_certificate.certificate_no", "application.terminal_phone", "old_vehicle.engine_model"]) {
    const step = makeStep({ step_id: `FIELD-${name}`, category: "FIELD", label: "审核字段", requires_reviewer_action: true, result_status: "CONFLICT", values: [{ source: "材料", value: "OCR-WRONG" }] });
    const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
      review: workbenchReview([step]), pageData: { pageFields: { [name]: "PAGE-WRONG" }, images: [] },
    }));
    assert.match(html, /<input[^>]*value="PAGE-WRONG"/);
    assert.ok(html.indexOf('class="manual-fill"') > html.indexOf('class="candidate-list"'));
    assert.doesNotMatch(html, /<mark class=""/);
    assert.equal((html.match(/回填此值/g) || []).length, 2);
  }
});

test("workbench merges an actionable date policy into its page field", () => {
  const dateField = makeStep({ step_id: "FIELD-invoice.invoice_date", sequence: 1, category: "FIELD", label: "开票日期", reason: "页面与发票日期一致" });
  const datePolicy = makeStep({ step_id: "BUSINESS-POLICY-INVOICE-DATE", sequence: 2, result_status: "CONFLICT", requires_reviewer_action: true, label: "新车发票日期", reason: "开票日期不符合政策范围" });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, { review: workbenchReview([dateField, datePolicy]), pageData: { pageFields: { "invoice.invoice_date": "2024-06-25" }, images: [] } }));

  assert.match(html, /页面原值/);
  assert.match(html, /2024-06-25/);
  assert.match(html, /地区政策核验/);
  assert.match(html, /开票日期不符合政策范围/);
  assert.equal((html.match(/新车发票日期/g) ?? []).length, 0);
});

test("material anomalies show Chinese field names, values and corresponding thumbnails", () => {
  const step = makeStep({step_id: "MATERIAL-UNCERTAIN-1", category: "MATERIAL", result_status: "INSUFFICIENT", requires_reviewer_action: true, reason: "报废证明存在无法确认的字段"});
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
    review: workbenchReview([step], {material_completeness: {status: "UNCERTAIN", issues: [{
      field_details: [
        {field: "old_vehicle.vin", field_label: "报废车辆车架号", material_name: "报废证明", value: "LG6?123", image_id: "scrap-1"},
        {field: "scrap_certificate.certificate_no", field_label: "报废证明编号", material_name: "报废证明", value: null, image_id: "scrap-2"},
      ],
    }], checklist: [{key: "scrap", display_name: "报废证明", status: "PRESENT", image_ids: []}]}}),
    pageData: {pageFields: {}, images: [{imageId: "scrap-1", src: "scrap-1.jpg"}, {imageId: "scrap-2", src: "scrap-2.jpg"}]},
  }));
  assert.match(html, /报废证明 · 报废车辆车架号/);
  assert.match(html, /LG6\?123/);
  assert.match(html, /未识别到有效值/);
  assert.match(html, /src="scrap-1.jpg"/);
  assert.match(html, /src="scrap-2.jpg"/);
  assert.equal((html.match(/查看原图/g) || []).length, 2);
  assert.match(html, /材料已提供/);
  assert.doesNotMatch(html, /scrap_certificate|old_vehicle.vin|已核验/);
});

test("field and external reviews only expose the manual review completion action", () => {
  for (const category of ["FIELD", "BUSINESS_RULE"]) {
    const step = makeStep({ step_id: category === "FIELD" ? "FIELD-page_ocr.new_vehicle_vin" : "BUSINESS-POLICY-NEW-ORIGIN", category, requires_reviewer_action: true, result_status: "CONFLICT", label: "核验项" });
    const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
      review: workbenchReview([step]), pageData: { pageFields: {}, images: [] },
    }));
    assert.match(html, /标记人工复核/);
    assert.doesNotMatch(html, /确认已核对|保留页面值/);
  }
});

test("invoice origin candidates show their matching invoice thumbnail and original image action", () => {
  for (const reference of [{image_id: "invoice-img"}, {image_index: 3}]) {
    const step = makeStep({step_id: "BUSINESS-POLICY-NEW-ORIGIN", category: "BUSINESS_RULE", result_status: "INSUFFICIENT", requires_reviewer_action: true, label: "新车发票产地", values: [{source: "新车销售发票", value: "长春", ...reference}]});
    const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
      review: workbenchReview([step]), pageData: {pageFields: {}, images: [
        {imageId: "unrelated", index: 1, src: "unrelated.jpg"},
        {imageId: "invoice-img", index: 3, src: "invoice.jpg"},
      ]},
    }));
    assert.match(html, /长春/);
    assert.match(html, /新车销售发票/);
    assert.match(html, /src="invoice.jpg"/);
    assert.match(html, /查看原图/);
    assert.doesNotMatch(html, /src="unrelated.jpg"/);
  }
});

test("QR official links remain clickable for manual review when backend access fails", () => {
  const url = "https://qclt.mofcom.gov.cn/deal/scrap/validdata/test";
  const step = makeStep({ step_id: "QR-1", category: "EXTERNAL", result_status: "INSUFFICIENT", requires_reviewer_action: true });
  for (const accessible of [false, null]) {
    const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
      review: workbenchReview([step], { qr_checks: [{ url, raw_value: url, domain_valid: true, accessible, page_fields: {}, status: "REVIEW_REQUIRED" }] }),
      pageData: { pageFields: {}, images: [] },
    }));
    assert.ok(html.includes(`href="${url}"`));
    assert.match(html, /target="_blank"/);
    assert.match(html, /noreferrer noopener/);
    assert.match(html, /后台暂未访问成功/);
    assert.match(html, /可点击网址人工核验/);
    assert.match(html, /待复核/);
  }
  for (const domain_valid of [false, null]) {
    const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
      review: workbenchReview([step], { qr_checks: [{ url, raw_value: url, domain_valid, accessible: false, page_fields: {}, status: "REVIEW_REQUIRED" }] }),
      pageData: { pageFields: {}, images: [] },
    }));
    assert.ok(!html.includes(`href="${url}"`));
    assert.match(html, /未取得已确认的官网网址/);
  }
});

test("workbench exposes only a backend-verified QR URL as a new-tab link", () => {
  const qrStep = makeStep({ step_id: "QR-1", sequence: 1, category: "EXTERNAL", result_status: "CONFLICT", requires_reviewer_action: true, label: "二维码官网核验", reason: "官网字段与图片不一致" });
  const url = "https://qcar.mofcom.gov.cn/query/1";
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, { review: workbenchReview([qrStep], { qr_checks: [{ url, domain_valid: true, accessible: true, page_fields: {}, status: "CONFLICT", message: "不一致" }] }), pageData: { pageFields: {}, images: [] } }));

  assert.match(html, new RegExp(`href="${url}"`));
  assert.match(html, /target="_blank"/);
  assert.match(html, /noopener/);
});

test("technical QR details keep a verified raw URL clickable for manual review", () => {
  const url = "https://qclt.mofcom.gov.cn/deal/scrap/validdata/manual";
  const step = makeStep({ step_id: "QR-1", sequence: 1, category: "EXTERNAL", result_status: "INSUFFICIENT", requires_reviewer_action: true, label: "二维码官网核验" });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
    review: workbenchReview([step], { qr_checks: [{ url, raw_value: url, domain_valid: true, accessible: false, page_fields: {}, status: "REVIEW_REQUIRED" }] }),
    pageData: { pageFields: {}, images: [] },
  }));
  const details = html.match(/<details class="qr-technical-details">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(details);
  assert.match(details, /原始二维码内容/);
  assert.ok(details.includes(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`));
  assert.match(html, /后台暂未访问成功/);
});

test("workbench keeps page values at the top and shows a material thumbnail beside its image action", () => {
  const field = makeStep({
    step_id: "FIELD-old_vehicle.vehicle_type",
    sequence: 1,
    category: "FIELD",
    label: "报废车辆类型",
    page_value: "牵引车",
    result_status: "CONFLICT",
    requires_reviewer_action: true,
    values: [
      { source: "申请页面字段", value: "牵引车" },
      { source: "图片识别", value: "重型半挂牵引车", image_id: "vehicle-license", image_index: 2, document_type: "vehicle_license" },
    ],
  });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
    review: workbenchReview([field]),
    pageData: { pageFields: { "old_vehicle.vehicle_type": "牵引车" }, images: [{ imageId: "vehicle-license", src: "vehicle-license.jpg", alt: "旧车行驶证" }] },
  }));

  assert.match(html, /页面原值/);
  assert.match(html, /牵引车/);
  assert.match(html, /重型半挂牵引车/);
  assert.match(html, /行驶证/);
  assert.match(html, /class="evidence-thumbnail"/);
  assert.match(html, /src="vehicle-license\.jpg"/);
  assert.match(html, /查看原图/);
  assert.doesNotMatch(html, /vehicle_license/);
  assert.doesNotMatch(html, /申请页面字段/);
});

test("workbench marks differing identifier positions in red", () => {
  const field = makeStep({
    step_id: "FIELD-new_vehicle.vin",
    sequence: 1,
    category: "FIELD",
    label: "新车车架号",
    page_value: "LFW5RX9L9TAA15882",
    result_status: "CONFLICT",
    requires_reviewer_action: true,
    values: [{ source: "图片识别", value: "LFW5RX9L9TAA15082", image_id: "vin", document_type: "vehicle_license" }],
  });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
    review: workbenchReview([field]),
    pageData: { pageFields: { "new_vehicle.vin": "LFW5RX9L9TAA15882" }, images: [] },
  }));

  assert.match(html, /class="value-diff"/);
  assert.match(html, /<mark class="value-diff"[^>]*>8<\/mark>/);
});

test("workbench labels a page invoice code derived from the invoice digital number", () => {
  const field = makeStep({
    step_id: "FIELD-invoice.code",
    sequence: 1,
    category: "FIELD",
    label: "发票代码",
    page_value: "2632000000731322946",
    result_status: "CONFLICT",
    requires_reviewer_action: true,
    values: [
      {
        source: "图片识别",
        value: "2632000000731322946",
        image_id: "invoice",
        document_type: "invoice",
        derived_from: "invoice.invoice_no",
      },
    ],
  });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
    review: workbenchReview([field]),
    pageData: { pageFields: { "invoice.code": "2632000000731322946" }, images: [] },
  }));

  assert.match(html, /由发票数电号码适配/);
});

test("workbench reports the actual DOM-derived field count and unknown controls", () => {
  const known = makeStep({ step_id: "FIELD-new_vehicle.vin", sequence: 1, category: "FIELD", label: "新车车架号" });
  const added = makeStep({ step_id: "FIELD-DOM-2", sequence: 2, category: "FIELD", label: "页面新增字段", page_value: "新增值", result_status: "INSUFFICIENT", requires_reviewer_action: true, reason: "未配置核验来源" });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, { review: workbenchReview([known, added]), pageData: { pageFields: {}, reviewFields: [], images: [] } }));

  assert.match(html, /本页控件 2/);
  assert.match(html, /全部字段 \(2\)/);
  assert.match(html, /页面新增字段/);
  assert.match(html, /页面原值/);
  assert.match(html, /新增值/);
});

test("workbench renders the six-item material checklist and blocks confirming a missing upload", () => {
  const materialStep = makeStep({ step_id: "MATERIAL-MISSING-1", sequence: 1, category: "MATERIAL", result_status: "INSUFFICIENT", requires_reviewer_action: true, label: "资料完整性", reason: "缺少新车行驶证" });
  const checklist = [
    ["old_vehicle:vehicle_license", "旧车行驶证", "PRESENT"],
    ["old_vehicle:registration_certificate", "旧车登记证", "PRESENT"],
    ["old_vehicle:scrap_certificate", "报废证明", "PRESENT"],
    ["new_vehicle:vehicle_license", "新车行驶证", "MISSING"],
    ["new_vehicle:registration_certificate", "新车登记证", "PRESENT"],
    ["new_vehicle:invoice", "新车发票", "PRESENT"],
  ].map(([key, display_name, status]) => ({ key, display_name, status, material_type: key.split(":")[1], business_scope: key.split(":")[0], required_pages: [], present_pages: [], missing_pages: [], image_ids: [], reason: status === "MISSING" ? `缺少${display_name}` : "材料已确认" }));
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, { review: workbenchReview([materialStep], { material_completeness: { phase: "EXTRACTED", status: "INCOMPLETE", enforced: true, issues: [], checklist } }), pageData: { pageFields: {}, images: [] } }));

  assert.equal((html.match(/材料已确认/g) ?? []).length, 5);
  assert.match(html, /新车行驶证/);
  assert.match(html, /缺失/);
  assert.doesNotMatch(html, /确认已核对/);
  assert.match(html, /标记人工复核/);
});

test("workbench renders dynamic identity requirements in the affiliation card", () => {
  const subject = makeStep({ step_id: "BUSINESS-AFFILIATION-SUBJECT-001", sequence: 1, category: "BUSINESS_RULE", result_status: "INSUFFICIENT", requires_reviewer_action: true, label: "新旧车挂靠主体关系", reason: "张三缺少身份证反面", details: { subject_requirements: [{ party: "SHARED", subject_name: "张三", subject_type: "PERSONAL", document: "identity_card_front", status: "PRESENT", image_ids: ["id-front"], reason: "身份证正面已确认" }, { party: "SHARED", subject_name: "张三", subject_type: "PERSONAL", document: "identity_card_back", status: "MISSING", image_ids: [], reason: "张三缺少身份证反面" }] } });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, { review: workbenchReview([subject]), pageData: { pageFields: {}, images: [{ imageId: "id-front", src: "front.jpg", alt: "身份证正面" }] } }));

  assert.match(html, /张三 · 身份证正面/);
  assert.match(html, /张三 · 身份证反面/);
  assert.match(html, /查看原图/);
});

test("affiliation card separates auxiliary blockers and shows only subject evidence", () => {
  const subject = makeStep({
    step_id: "BUSINESS-AFFILIATION-SUBJECT-001",
    sequence: 1,
    category: "BUSINESS_RULE",
    label: "新旧车挂靠主体关系",
    reason: "新旧车公司法定名称一致且营业执照已确认",
    values: [{ source: "旧车所有人", value: "甲运输有限公司" }],
    evidence: [
      { source: "营业执照", image_id: "license", field: "business_license.company_name", value: "甲运输有限公司" },
      { source: "旧车登记证", image_id: "registration", field: "old_vehicle.owner", value: "甲运输有限公司" },
    ],
    details: {
      subject_requirements: [{ party: "SHARED", subject_name: "甲运输有限公司", subject_type: "COMPANY", document: "business_license", status: "PRESENT", image_ids: ["license"], reason: "营业执照名称已确认" }],
    },
  });
  const vin = makeStep({
    step_id: "BUSINESS-AFFILIATION-AUX-NEW-VIN",
    sequence: 2,
    category: "BUSINESS_RULE",
    result_status: "INSUFFICIENT",
    requires_reviewer_action: true,
    label: "OCR新车车架号",
    reason: "页面或材料未取得可比较的明确值",
  });
  const html = renderToStaticMarkup(React.createElement(ScrapReplacementReview, {
    review: workbenchReview([subject, vin]),
    pageData: { pageFields: {}, images: [
      { imageId: "license", src: "license.jpg", alt: "营业执照原图" },
      { imageId: "registration", src: "registration.jpg", alt: "登记证原图" },
    ] },
  }));

  assert.match(html, /关联辅助核验/);
  assert.match(html, /OCR新车车架号/);
  assert.match(html, /页面或材料未取得可比较的明确值/);
  assert.match(html, /营业执照原图/);
  assert.doesNotMatch(html, /登记证原图/);
});
