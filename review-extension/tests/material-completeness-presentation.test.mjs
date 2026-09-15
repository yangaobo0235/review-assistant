import assert from "node:assert/strict";
import test from "node:test";

import { materialIssuePresentation } from "../src/materialCompletenessPresentation.ts";

test("presents unconfirmed pages without claiming the files are absent", () => {
  const item = materialIssuePresentation({
    code: "MISSING_REGISTRATION_PAGES",
    missing_pages: [1, 2],
    message: "机动车登记证第1、2页未能确认",
    suggested_action: "请检查原图或补充清晰图片",
    reason_code: "recognition_uncertain",
    reason_detail: "页码区域可能模糊、遮挡或不可辨认",
  });

  assert.equal(item.title, "登记证第 1、2 页未能确认");
  assert.equal(item.reason, "页码区域可能模糊、遮挡或不可辨认");
});

test("translates technical field and source names for reviewers", () => {
  const item = materialIssuePresentation({
    code: "MISSING_FIELD_SOURCE",
    field: "invoice.invoice_date",
    missing_sources: ["invoice"],
    message: "开票日期缺少机动车销售发票证据",
    suggested_action: "请检查发票日期区域或补充清晰图片",
    reason_code: "recognition_uncertain",
    reason_detail: "日期区域可能模糊、遮挡或不可辨认",
  });

  assert.equal(item.title, "开票日期证据不完整");
  assert.equal(item.reason, "缺少来源：机动车销售发票。日期区域可能模糊、遮挡或不可辨认");
});

test("translates technical material names in fallback issue messages", () => {
  const item = materialIssuePresentation({
    code: "UNCERTAIN_REQUIRED_FIELD",
    material_type: "registration_certificate",
    message: "registration_certificate存在无法确认的字段",
    suggested_action: "请查看原图；如图片模糊或遮挡，请补充清晰图片",
    reason_code: "recognition_uncertain",
    reason_detail: "图片可能模糊、遮挡或关键信息不可辨认",
  });

  assert.equal(item.title, "机动车登记证书存在无法确认的字段");
});
