import assert from "node:assert/strict";
import test from "node:test";
import { ReviewBusinessDetector } from "../src/browser/business-detector.ts";

function loadDetector() {
  return ReviewBusinessDetector;
}

test("detects known business routes", () => {
  const { detect } = loadDetector();

  assert.deepEqual(
    { ...detect("http://localhost:5173/scrap-replace-qingdao", "") },
    {
      businessType: "scrap_replacement",
      region: "qingdao",
      profileVersion: "1.0",
      workflowStage: "scrap_replacement",
      selectionMode: "AUTO",
      detectionStatus: "CONFIRMED",
    },
  );
  assert.equal(
    detect("http://localhost:5173/vehicle-source", "").businessType,
    "vehicle_source",
  );
  assert.equal(
    detect("http://localhost:5173/consistency-qingdao", "").businessType,
    "consistency",
  );
  assert.deepEqual(
    { ...detect("https://admin.forjtruck.com/scrap-replace-changchun?showPageModel=1", "") },
    {
      businessType: "scrap_replacement",
      region: "changchun",
      profileVersion: "1.0",
      workflowStage: "scrap_replacement",
      selectionMode: "AUTO",
      detectionStatus: "CONFIRMED",
    },
  );
  assert.equal(
    detect("https://admin.forjtruck.com/scrap-replace-qingdao?showPageModel=1", "").region,
    "qingdao",
  );
  assert.deepEqual(
    { ...detect("https://admin.forjtruck.com/consistency-changchun?showPageModel=1", "") },
    {
      businessType: "consistency",
      region: "changchun",
      profileVersion: "1.0",
      workflowStage: "consistency",
      selectionMode: "AUTO",
      detectionStatus: "CONFIRMED",
    },
  );
});

test("matches complete route segments instead of similar prefixes", () => {
  const { detect } = loadDetector();

  assert.equal(detect("https://admin.forjtruck.com/scrap-replace-qingdao-old", ""), null);
  assert.equal(detect("https://admin.forjtruck.com/scrap-replace-qingdao/detail/1", "").region, "qingdao");
});

test("rejects a manual region that conflicts with the detected page route", () => {
  const { resolve } = loadDetector();
  const manual = {
    businessType: "scrap_replacement",
    region: "qingdao",
    profileVersion: "1.0",
    workflowStage: "scrap_replacement",
  };

  assert.deepEqual(
    { ...resolve("https://admin.forjtruck.com/scrap-replace-changchun", "", manual) },
    {
      business: null,
      error: "人工选择的审核地区与当前页面不一致，请重新确认",
    },
  );
});

test("does not guess a region-specific profile from page text alone", () => {
  const { detect } = loadDetector();

  assert.equal(detect("http://localhost:5173/review", "申请信息 报废车辆信息 报废证明编号"), null);
  assert.equal(detect("http://localhost:5173/review", "一致性审核"), null);
  assert.equal(
    detect("http://localhost:5173/review", "车源审核 车辆来源信息").businessType,
    "vehicle_source",
  );
});

test("returns unknown when neither URL nor page fingerprint matches", () => {
  assert.equal(
    loadDetector().detect("http://localhost:5173/other", "普通页面"),
    null,
  );
});

test("keeps the generic consistency route when transfer evidence is present", () => {
  const detected = loadDetector().detect(
    "http://localhost:5173/consistency-qingdao/review/1",
    "青岛一致性审核 审核过户凭证 过户发票买家名称 卖方名称 车源发布时间",
  );

  assert.equal(detected.businessType, "consistency");
  assert.equal(detected.region, "qingdao");
});
