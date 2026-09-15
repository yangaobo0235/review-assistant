import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ReviewPageFieldWriter } from "../src/browser/page-field-writer.ts";

const fixture = readFileSync(
  new URL("./fixtures/scrap-replacement-affiliation.html", import.meta.url),
  "utf8",
);
const writer = readFileSync(new URL("../src/browser/page-field-writer.ts", import.meta.url), "utf8");

test("sanitized Ant Design fixture retains the two affiliation labels and their owned listboxes", () => {
  assert.match(fixture, /<label[^>]*>报废车挂靠<\/label>/);
  assert.match(fixture, /<label[^>]*>新车挂靠<\/label>/);
  assert.match(fixture, /aria-controls="affiliation-old-options"/);
  assert.match(fixture, /aria-controls="affiliation-new-options"/);
  assert.match(fixture, /id="affiliation-old-options"[^>]*role="listbox"/);
  assert.match(fixture, /id="affiliation-new-options"[^>]*role="listbox"/);
  assert.match(fixture, /role="option"[^>]*>企业<\/div>/);
});

test("writer resolves custom options only from the combobox-owned listbox", () => {
  assert.match(writer, /getElementById\?\.\(resolved\.listboxId\)/);
  assert.match(writer, /customOptions[\s\S]*queryAll\(listbox, OPTION_SELECTOR\)/);
  assert.doesNotMatch(writer, /queryAll\(root, OPTION_SELECTOR\)/);
});

test("writer keeps the exact two-field allowlist and rolls back failed invocations", () => {
  assert.match(writer, /ALLOWED_TARGETS = Object\.freeze\(\{ "old_vehicle\.affiliation": "报废车挂靠", "new_vehicle\.affiliation": "新车挂靠" \}\)/);
  assert.match(writer, /snapshotValue/);
  assert.match(writer, /restoreControl/);
  assert.match(writer, /已回滚/);
  assert.match(writer, /自动回滚未完成/);
});

test("fixture keeps a pre-filled second affiliation control for the blocked-write scenario", () => {
  assert.match(fixture, /<span class="ant-select-selection-item">企业<\/span>/);
  assert.match(fixture, /aria-controls="affiliation-new-options"[^>]*value="企业"/);
});

// 以下回归把夹具语义接到真实 writer 上：夹具保留的“新车挂靠已有值”必须让两个字段都不被写入，
// 且写入前后始终受页面身份守卫约束。stub 复刻 Ant Design 挂靠控件的可写路径。
function loadWriter(globalOverrides = {}) {
  Object.assign(globalThis, globalOverrides);
  return ReviewPageFieldWriter;
}

function antRoot(definitions) {
  const root = {
    openField: null,
    defaultView: { Event: class Event {} },
    querySelectorAll(selector) {
      if (selector.includes("form-item")) return definitions.map((definition) => definition.field.item);
      return [];
    },
    getElementById(id) {
      const definition = definitions.find((item) => item.field.listboxId === id);
      if (!definition) return null;
      return {
        querySelectorAll(selector) {
          return selector.includes("option") && root.openField === definition.field
            ? definition.field.options
            : [];
        },
      };
    },
  };
  for (const definition of definitions) {
    const field = {
      value: definition.current || "",
      clicks: 0,
      options: definition.values.map((text) => ({
        textContent: text,
        isConnected: true,
        getAttribute: () => null,
        click() {
          field.value = text;
          root.openField = null;
        },
      })),
    };
    const trigger = {
      isConnected: true,
      click() { root.openField = root.openField === field ? null : field; },
      getAttribute: () => null,
    };
    field.listboxId = `listbox-${definitions.indexOf(definition)}`;
    const combobox = {
      isConnected: true,
      click() { field.clicks += 1; trigger.click(); },
      getAttribute(name) { return name === "aria-controls" ? field.listboxId : null; },
    };
    field.combobox = combobox;
    const labelNode = { textContent: definition.label, innerText: definition.label };
    field.item = {
      querySelector(selector) {
        if (selector.includes("label")) return labelNode;
        if (selector.includes("selection-item")) {
          return field.value ? { textContent: field.value, innerText: field.value } : null;
        }
        if (selector === "[role='combobox'], input[aria-controls], input[aria-owns]") return combobox;
        if (selector.includes("selector") || selector.includes("combobox")) return trigger;
        return null;
      },
      querySelectorAll(selector) {
        if (selector.includes("combobox") || selector.includes("aria-controls")) return [combobox];
        return [];
      },
    };
    definition.field = field;
  }
  return root;
}

const intent = [
  { field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "PERSONAL" },
  { field: "new_vehicle.affiliation", target_label: "新车挂靠", owner_type: "COMPANY" },
];

test("the fixture's pre-filled 新车挂靠 blocks both writes end to end", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"], current: "企业" },
  ];

  const result = await loadWriter({ setTimeout }).execute(antRoot(definitions), intent);

  assert.equal(result.ok, false);
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /已有值|禁止覆盖/);
  // 空白旧车挂靠保持未写入，已有值的新车挂靠保持原值；预检失败发生在任何点击之前。
  assert.equal(definitions[0].field.value, "");
  assert.equal(definitions[1].field.value, "企业");
  assert.equal(definitions[0].field.clicks, 0);
  assert.equal(definitions[1].field.clicks, 0);
});

test("a stale page identity stops the write before any option click", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];

  const result = await loadWriter({ setTimeout }).execute(antRoot(definitions), intent, () => false);

  assert.equal(result.ok, false);
  assert.match(result.message, /页面已变化|重新审核/);
  assert.equal(definitions[0].field.value, "");
  assert.equal(definitions[1].field.value, "");
  assert.equal(definitions[0].field.clicks, 0);
  assert.equal(definitions[1].field.clicks, 0);
});

test("writer source enforces all five joint-preflight conditions before writing", () => {
  // 目标唯一：恰好一个匹配标签的表单项、一个逻辑控件。
  assert.match(writer, /items\.length !== 1/);
  assert.match(writer, /nativeControls\.length \+ combos\.length > 1/);
  // 当前为空：写入前与回读前均拒绝已有值。
  assert.match(writer, /已有值，禁止覆盖/);
  assert.match(writer, /currentValue\(resolved\)/);
  // 控件可用：连接、可见、未禁用、非只读。
  assert.match(writer, /connected\(element\) && !hidden\(element\) && !disabled\(element\)/);
  assert.match(writer, /控件不可写或已变化/);
  // 选项唯一：个人/公司别名恰好命中一个可写选项。
  assert.match(writer, /options\.length !== 1/);
  // 页面身份一致：守卫在每个写入/回读/回滚边界复检。
  assert.match(writer, /sameCollectedRecord\(guard\)/);
  assert.match(writer, /页面已变化，请重新审核/);
  // 回滚走受控写入路径并遵守字段白名单。
  assert.match(writer, /if \(!ALLOWED_TARGETS\[action\.field\]\) return/);
  assert.match(writer, /不在允许写入的字段内/);
});
