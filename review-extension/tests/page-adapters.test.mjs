/**
 * 页面适配器注册表：全应用的页面识别入口。
 *
 * 识别规则在各适配器里，`business-detector` 只做识别入口和人工/自动冲突判定。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildPageAdapterRegistry } from "../src/adapters/index.ts";
import { ReviewBusinessDetector } from "../src/browser/business-detector.ts";

const registry = buildPageAdapterRegistry();

test("每个已知页面都解析到自己的适配器", () => {
  const cases = [
    ["https://admin.forjtruck.com/scrap-replace-qingdao", "scrap-replacement"],
    ["https://admin.forjtruck.com/scrap-replace-changchun?showPageModel=1", "scrap-replacement"],
    ["https://admin.forjtruck.com/vehicle-source", "vehicle-source"],
    ["https://admin.forjtruck.com/consistency-qingdao", "consistency"],
    ["https://admin.forjtruck.com/consistency-changchun", "consistency"],
  ];

  for (const [url, expected] of cases) {
    assert.equal(registry.resolve(url)?.id, expected, url);
  }
});

test("未登记的页面不解析到任何适配器", () => {
  assert.equal(registry.resolve("https://admin.forjtruck.com/unknown-page"), null);
  assert.equal(registry.selection("not a url"), null);
});

test("页面识别按完整路径段匹配，相似前缀不算命中", () => {
  // 相似前缀不能互相误判：/scrap-replace-qingdao-old 不是审核页。
  assert.equal(registry.resolve("https://admin.forjtruck.com/scrap-replace-qingdao-old"), null);
  assert.equal(registry.resolve("https://admin.forjtruck.com/consistency-qingdaox"), null);
});

test("注册表给出的业务选择与识别入口一致", () => {
  const url = "https://admin.forjtruck.com/scrap-replace-changchun?showPageModel=1";

  assert.deepEqual(registry.selection(url), ReviewBusinessDetector.detect(url, ""));
  assert.deepEqual(ReviewBusinessDetector.detect(url, ""), {
    businessType: "scrap_replacement",
    region: "changchun",
    profileVersion: "1.0",
    workflowStage: "scrap_replacement",
    selectionMode: "AUTO",
    detectionStatus: "CONFIRMED",
  });
});

test("人工选择的地区与页面不一致时拒绝执行", () => {
  const resolution = ReviewBusinessDetector.resolve(
    "https://admin.forjtruck.com/scrap-replace-changchun",
    "",
    {
      businessType: "scrap_replacement",
      region: "qingdao",
      profileVersion: "1.0",
      workflowStage: "scrap_replacement",
      selectionMode: "MANUAL",
    },
  );

  assert.equal(resolution.business, null);
  assert.match(resolution.error, /不一致/);
});

test("适配器只声明可写控件，不声明页面字段", () => {
  // 字段别名、页面分区和图片筛选依据来自后端采集清单；适配器不该再有一份。
  const scrap = registry.get("scrap-replacement");
  assert.deepEqual(scrap.listWritableFields(), []);

  const source = scrap.constructor.toString() + scrap.detect.toString();
  assert.equal(source.includes("FIELD_DEFINITIONS"), false);
  assert.equal(source.includes("aliases"), false);
});
