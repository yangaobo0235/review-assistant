import assert from "node:assert/strict";
import test from "node:test";
import { ReviewPageFieldWriter } from "../src/browser/page-field-writer.ts";

function loadWriter(globalOverrides = {}) {
  Object.assign(globalThis, globalOverrides);
  return ReviewPageFieldWriter;
}

function option(text, { disabled = false, value = text } = {}) {
  return {
    textContent: text,
    value,
    disabled,
    selected: false,
    getAttribute(name) {
      return name === "aria-disabled" ? String(disabled) : null;
    },
  };
}

function nativeField(label, values, current = "", attributes = {}) {
  const options = values.map((value) => typeof value === "string" ? option(value) : option(value.label, value));
  const select = {
    tagName: "SELECT",
    value: current,
    isConnected: true,
    options,
    selectedOptions: current ? [option(current)] : [],
    dispatchEvent() {},
    ...attributes,
  };
  const labelNode = { textContent: label, innerText: label };
  const item = {
    textContent: label,
    innerText: label,
    querySelector(selector) {
      if (selector.includes("label")) return labelNode;
      if (selector.includes("select")) return select;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "select" ? [select] : [];
    },
  };
  return { item, select };
}

function nativeRoot(fields) {
  return {
    defaultView: { Event: class Event { constructor(type) { this.type = type; } } },
    querySelectorAll(selector) {
      return selector.includes("form-item") ? fields.map((field) => field.item) : [];
    },
  };
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
      click() { trigger.click(); },
      getAttribute(name) {
        return name === "aria-controls" ? field.listboxId : null;
      },
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

const actions = [
  { field: "old_vehicle.affiliation", target_label: "报废车挂靠", owner_type: "PERSONAL" },
  { field: "new_vehicle.affiliation", target_label: "新车挂靠", owner_type: "COMPANY" },
];

test("fills both empty native affiliation controls only after joint preflight", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, true);
  assert.equal(oldField.select.value, "个人");
  assert.equal(newField.select.value, "企业");
  assert.deepEqual(Array.from(result.actions, (item) => item.status), ["FILLED", "FILLED"]);
});

test("fills radio-style affiliation controls when a deployed shell renders radios instead of a select", async () => {
  function radioField(label, labels) {
    const item = {
      isConnected: true,
      querySelector(selector) {
        if (selector.includes("label")) return { textContent: label, innerText: label };
        return null;
      },
      querySelectorAll(selector) {
        return selector.includes("radio") ? controls : [];
      },
    };
    const controls = labels.map((choice) => {
      const wrapper = {
        tagName: "LABEL",
        textContent: choice,
        innerText: choice,
        parentElement: item,
        getAttribute: () => null,
      };
      const control = {
        tagName: "INPUT",
        type: "radio",
        value: choice,
        checked: false,
        isConnected: true,
        parentElement: wrapper,
        getAttribute(name) { return name === "type" ? "radio" : null; },
        closest(selector) {
          if (selector.includes("label")) return wrapper;
          if (selector.includes("radiogroup")) return item;
          return null;
        },
        click() {
          controls.forEach((other) => { other.checked = false; });
          control.checked = true;
        },
        dispatchEvent() {},
      };
      return control;
    });
    return { item, controls };
  }

  const oldField = radioField("报废车挂靠", ["个人", "公司"]);
  const newField = radioField("新车挂靠", ["个人", "企业"]);
  const root = {
    defaultView: { Event: class Event {} },
    querySelectorAll(selector) {
      return selector.includes("form-item") ? [oldField.item, newField.item] : [];
    },
  };

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, true);
  assert.equal(oldField.controls.find((control) => control.checked).value, "个人");
  assert.equal(newField.controls.find((control) => control.checked).value, "企业");
});

test("ignores hidden duplicate forms and writes only the visible affiliation controls", async () => {
  const hiddenOld = nativeField("报废车挂靠", ["个人", "公司"]);
  hiddenOld.item.style = { display: "none" };
  const visibleOld = nativeField("报废车挂靠", ["个人", "公司"]);
  const visibleNew = nativeField("新车挂靠", ["个人", "企业"]);

  const result = await loadWriter().execute(nativeRoot([
    hiddenOld,
    visibleOld,
    visibleNew,
  ]), actions);

  assert.equal(result.ok, true);
  assert.equal(hiddenOld.select.value, "");
  assert.equal(visibleOld.select.value, "个人");
  assert.equal(visibleNew.select.value, "企业");
});

test("fills the Ant Design controls used by the production review page", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];

  const result = await loadWriter().execute(antRoot(definitions), actions);

  assert.equal(result.ok, true);
  assert.equal(definitions[0].field.value, "个人");
  assert.equal(definitions[1].field.value, "企业");
});

test("waits briefly for a framework dropdown to render its options", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];
  const root = antRoot(definitions);
  let optionQueries = 0;
  const originalQuery = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => {
    if (selector.includes("option") && ++optionQueries % 2 === 1) return [];
    return originalQuery(selector);
  };

  const result = await loadWriter({ setTimeout }).execute(root, actions);

  assert.equal(result.ok, true);
  assert.equal(definitions[0].field.value, "个人");
  assert.equal(definitions[1].field.value, "企业");
});

test("does not write either field when a target is missing, duplicated, or already has a value", async () => {
  for (const fields of [
    [nativeField("报废车挂靠", ["个人", "公司"])],
    [nativeField("报废车挂靠", ["个人", "公司"]), nativeField("新车挂靠", ["个人", "企业"]), nativeField("新车挂靠", ["个人", "企业"])],
    [nativeField("报废车挂靠", ["个人", "公司"], "个人"), nativeField("新车挂靠", ["个人", "企业"])],
  ]) {
    const result = await loadWriter().execute(nativeRoot(fields), actions);
    assert.equal(result.ok, false);
    for (const field of fields) {
      assert.notEqual(field.select.value, field === fields.at(-1) && fields.length === 2 ? "企业" : "公司");
    }
  }
});

test("does not write either field when an option is missing or ambiguous", async () => {
  const missing = [nativeField("报废车挂靠", ["个人", "公司"]), nativeField("新车挂靠", ["个人"])];
  const ambiguous = [nativeField("报废车挂靠", ["个人", "公司"]), nativeField("新车挂靠", ["公司", "企业"])];

  assert.equal((await loadWriter().execute(nativeRoot(missing), actions)).ok, false);
  assert.equal((await loadWriter().execute(nativeRoot(ambiguous), actions)).ok, false);
  assert.equal(missing[0].select.value, "");
  assert.equal(ambiguous[0].select.value, "");
});

test("rejects every field and label outside the two affiliation allowlists", async () => {
  const fields = [nativeField("审核结果", ["通过", "驳回"]), nativeField("新车挂靠", ["个人", "企业"])];
  const unsafe = [
    { field: "review.result", target_label: "审核结果", owner_type: "PERSONAL" },
    actions[1],
  ];

  const result = await loadWriter().execute(nativeRoot(fields), unsafe);

  assert.equal(result.ok, false);
  assert.match(result.message, /不允许自动填写/);
  assert.equal(fields[0].select.value, "");
});

test("rolls back the first write when a rerender invalidates the remaining target", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  const root = nativeRoot([oldField, newField]);
  const originalDispatch = oldField.select.dispatchEvent;
  oldField.select.dispatchEvent = (event) => {
    originalDispatch(event);
    newField.select.isConnected = false;
  };

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(newField.select.value, "");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /页面已刷新|控件已变化/);
  assert.match(result.message, /已回滚/);
});

test("rolls back the first write and never overwrites the second field when the first field triggers a linked value", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  oldField.select.dispatchEvent = () => {
    newField.select.value = "个人";
  };

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(newField.select.value, "个人");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /已有值|禁止覆盖/);
  assert.match(result.message, /已回滚/);
});

test("rolls back the first write when it adds an ambiguous owner option to the second field", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  oldField.select.dispatchEvent = () => {
    newField.select.options.push(option("公司"));
  };

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(newField.select.value, "");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /存在歧义|选项已变化/);
  assert.match(result.message, /已回滚/);
});

test("does not click an unrelated dropdown option when a target has no associated listbox", async () => {
  let unrelatedClicks = 0;
  const unrelatedOption = { textContent: "个人", isConnected: true, getAttribute: () => null, click() { unrelatedClicks += 1; } };
  const root = nativeRoot([]);
  const field = {
    item: {
      querySelector(selector) {
        if (selector.includes("label")) return { textContent: "报废车挂靠" };
        if (selector.includes("combobox")) return { isConnected: true, click() {}, getAttribute: () => null };
        return null;
      },
      querySelectorAll(selector) {
        return selector.includes("combobox") ? [this.querySelector(selector)] : [];
      },
    },
  };
  const other = nativeField("新车挂靠", ["个人", "企业"]);
  root.querySelectorAll = (selector) => selector.includes("form-item") ? [field.item, other.item] : [unrelatedOption];

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(unrelatedClicks, 0);
});

test("reads an Element input value and refuses to replace an existing choice", async () => {
  const input = { value: "公司", isConnected: true, getAttribute: (name) => name === "aria-controls" ? "old-options" : null };
  const oldItem = {
    querySelector(selector) {
      if (selector.includes("label")) return { textContent: "报废车挂靠" };
      if (selector.includes("el-input__inner")) return input;
      if (selector.includes("combobox")) return input;
      return null;
    },
    querySelectorAll(selector) { return selector.includes("combobox") ? [input] : []; },
  };
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  const root = nativeRoot([{ item: oldItem }, newField]);
  root.getElementById = () => ({ querySelectorAll: () => [option("个人")] });

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.match(result.message, /已有值|禁止覆盖/);
  assert.equal(input.value, "公司");
});

test("treats an empty native placeholder as blank and verifies numeric option values by label", async () => {
  const oldField = nativeField("报废车挂靠", [
    { label: "请选择", value: "" }, { label: "个人", value: "1" }, { label: "公司", value: "2" },
  ]);
  const newField = nativeField("新车挂靠", [
    { label: "请选择", value: "" }, { label: "个人", value: "1" }, { label: "企业", value: "2" },
  ]);

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, true);
  assert.equal(oldField.select.value, "1");
  assert.equal(newField.select.value, "2");
});

test("refuses disabled controls and multiple logical controls inside one field item", async () => {
  const disabled = nativeField("报废车挂靠", ["个人", "公司"], "", { disabled: true });
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  const disabledResult = await loadWriter().execute(nativeRoot([disabled, newField]), actions);
  assert.equal(disabledResult.ok, false);
  assert.equal(disabled.select.value, "");

  const duplicated = nativeField("报废车挂靠", ["个人", "公司"]);
  duplicated.item.querySelectorAll = (selector) => selector === "select" ? [duplicated.select, { ...duplicated.select }] : [];
  const duplicateResult = await loadWriter().execute(nativeRoot([duplicated, newField]), actions);
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicated.select.value, "");
});

test("opens an aria-owned listbox that mounts only after the combobox click", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];
  const root = antRoot(definitions);
  const originalLookup = root.getElementById.bind(root);
  root.getElementById = (id) => root.openField ? originalLookup(id) : null;

  const result = await loadWriter({ setTimeout }).execute(root, actions);

  assert.equal(result.ok, true);
  assert.equal(definitions[0].field.value, "个人");
  assert.equal(definitions[1].field.value, "企业");
});

test("does not click a custom option after the open wait gives the field a value", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];
  const root = antRoot(definitions);
  const originalClick = definitions[0].field.combobox.click;
  let clicks = 0;
  definitions[0].field.combobox.click = () => {
    clicks += 1;
    originalClick();
    if (clicks === 5) definitions[0].field.value = "公司";
  };

  const result = await loadWriter({ setTimeout }).execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(definitions[0].field.value, "公司");
  assert.equal(definitions[1].field.value, "");
  assert.match(result.message, /已有值|禁止覆盖|选项或控件已变化/);
});

test("stops when a hidden form-item ancestor contains an otherwise empty native control", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  oldField.item.parentElement = { style: { display: "none" } };
  const newField = nativeField("新车挂靠", ["个人", "企业"]);

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
});

test("rolls back the first write instead of filling a replacement control after preflight", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const originalNew = nativeField("新车挂靠", ["个人", "企业"]);
  const replacementNew = nativeField("新车挂靠", ["个人", "企业"]);
  const fields = [oldField, originalNew];
  const root = nativeRoot(fields);
  oldField.select.dispatchEvent = () => {
    originalNew.select.isConnected = false;
    fields[1] = replacementNew;
  };

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(replacementNew.select.value, "");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /控件已变化|页面已刷新/);
  assert.match(result.message, /已回滚/);
});

test("writes nothing when the collected record changes while opening the first custom control", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];
  const root = antRoot(definitions);
  const originalClick = definitions[0].field.combobox.click;
  let clicks = 0;
  let record = "case-a";
  definitions[0].field.combobox.click = () => {
    clicks += 1;
    originalClick();
    if (clicks === 5) record = "case-b";
  };

  const result = await loadWriter({ setTimeout }).execute(root, actions, () => record === "case-a");

  assert.equal(result.ok, false);
  assert.equal(definitions[0].field.value, "");
  assert.equal(definitions[1].field.value, "");
  assert.match(result.message, /页面已变化|重新审核/);
});

test("writes neither pending field when the second custom control gains a value during the first open wait", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];
  const root = antRoot(definitions);
  const originalClick = definitions[0].field.combobox.click;
  let clicks = 0;
  definitions[0].field.combobox.click = () => {
    clicks += 1;
    originalClick();
    if (clicks === 5) definitions[1].field.value = "个人";
  };

  const result = await loadWriter({ setTimeout }).execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(definitions[0].field.value, "");
  assert.equal(definitions[1].field.value, "个人");
  assert.match(result.message, /已有值|禁止覆盖|选项或控件已变化/);
});

test("stops when computed style hides a form-item ancestor", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  const root = nativeRoot([oldField, newField]);
  const document = {
    defaultView: {
      getComputedStyle(node) {
        return node === oldField.item
          ? { display: "none", visibility: "visible" }
          : { display: "block", visibility: "visible" };
      },
    },
  };
  oldField.item.ownerDocument = document;
  oldField.select.ownerDocument = document;
  newField.item.ownerDocument = document;
  newField.select.ownerDocument = document;

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(newField.select.value, "");
});

test("writes neither field when a pending custom control gains a value during native preflight", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const definitions = [{ label: "新车挂靠", values: ["个人", "企业"] }];
  const root = antRoot(definitions);
  const newField = definitions[0].field;
  const originalQuery = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => selector.includes("form-item")
    ? [oldField.item, newField.item]
    : originalQuery(selector);
  const originalClick = newField.combobox.click;
  let clicks = 0;
  newField.combobox.click = () => {
    clicks += 1;
    originalClick();
    if (clicks === 4) newField.value = "个人";
  };

  const result = await loadWriter({ setTimeout }).execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(newField.value, "个人");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /已有值|禁止覆盖/);
});

test("a non-empty affiliation target prevents both writes", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"], "已有值");
  const newField = nativeField("新车挂靠", ["个人", "企业"]);

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "已有值");
  assert.equal(newField.select.value, "");
});

test("writer rejects every field outside the two-field allowlist", async () => {
  const vinField = nativeField("新车车架号", ["VIN-ORIGINAL"], "VIN-ORIGINAL");
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  const root = nativeRoot([vinField, newField]);

  const single = await loadWriter().execute(root, [{ field: "new_vehicle.vin" }]);
  assert.equal(single.ok, false);
  assert.equal(vinField.select.value, "VIN-ORIGINAL");

  const swapped = await loadWriter().execute(root, [
    { field: "new_vehicle.vin", target_label: "新车车架号", owner_type: "PERSONAL" },
    actions[1],
  ]);
  assert.equal(swapped.ok, false);
  assert.match(swapped.message, /不允许自动填写/);
  assert.equal(vinField.select.value, "VIN-ORIGINAL");
  assert.equal(newField.select.value, "");
});

test("reports a failed readback and leaves no written value behind", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  oldField.select.dispatchEvent = () => {
    oldField.select.value = "";
  };

  const result = await loadWriter().execute(nativeRoot([oldField, newField]), actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.select.value, "");
  assert.equal(newField.select.value, "");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /回读失败/);
  assert.match(result.message, /已回滚/);
});

test("reports rollback failure instead of a silent partial write when the written control is replaced", async () => {
  const oldField = nativeField("报废车挂靠", ["个人", "公司"]);
  const newField = nativeField("新车挂靠", ["个人", "企业"]);
  const fields = [oldField, newField];
  const root = nativeRoot(fields);
  const replacementOld = nativeField("报废车挂靠", ["个人", "公司"]);
  const originalDispatch = oldField.select.dispatchEvent;
  oldField.select.dispatchEvent = (event) => {
    originalDispatch(event);
    newField.select.isConnected = false;
    fields[0] = replacementOld;
  };

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /自动回滚未完成/);
  assert.match(result.message, /请人工核对/);
  assert.equal(oldField.select.value, "个人");
  assert.equal(replacementOld.select.value, "");
  assert.equal(newField.select.value, "");
});

test("rolls back a filled custom control through its clear affordance when the second field fails", async () => {
  const definitions = [
    { label: "报废车挂靠", values: ["个人", "公司"] },
    { label: "新车挂靠", values: ["个人", "企业"] },
  ];
  const root = antRoot(definitions);
  const oldField = definitions[0].field;
  const newField = definitions[1].field;
  const itemQuery = oldField.item.querySelector.bind(oldField.item);
  oldField.item.querySelector = (selector) => {
    if (selector.includes("ant-select-clear")) {
      return {
        isConnected: true,
        getAttribute: () => null,
        click() { oldField.value = ""; },
      };
    }
    return itemQuery(selector);
  };
  const personalOption = oldField.options.find((item) => item.textContent === "个人");
  const optionClick = personalOption.click.bind(personalOption);
  personalOption.click = () => {
    optionClick();
    newField.value = "个人";
  };

  const result = await loadWriter().execute(root, actions);

  assert.equal(result.ok, false);
  assert.equal(oldField.value, "");
  assert.equal(newField.value, "个人");
  assert.equal(result.actions.length, 0);
  assert.match(result.message, /已有值|禁止覆盖/);
  assert.match(result.message, /已回滚/);
});

function valueInput(initial = "") {
  return {
    tagName: "INPUT",
    value: initial,
    isConnected: true,
    getAttribute: () => null,
    dispatchEvent() {},
  };
}

test("manual values are read back before centering, focusing and highlighting the target", async () => {
  const input = valueInput("HS-OLD");
  const calls = [];
  input.scrollIntoView = (options) => { assert.equal(input.value, "HS-MANUAL"); calls.push(options.block); };
  input.focus = () => calls.push("focus");
  input.animate = () => calls.push("highlight");
  const result = await loadWriter({ setTimeout }).executeValue(
    { defaultView: { Event: class Event {} } }, input,
    { field: "scrap_certificate.certificate_no", value: "HS-MANUAL", expectedValue: "HS-OLD" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["center", "focus", "highlight"]);
  assert.equal(result.actions[0].value, "HS-MANUAL");
});

test("manual input supports phone fields and does not focus a failed or readonly write", async () => {
  const input = valueInput("13800000000");
  let focused = false;
  input.focus = () => { focused = true; };
  const writer = loadWriter({ setTimeout });
  const root = { defaultView: { Event: class Event {} } };
  input.readOnly = true;
  assert.equal((await writer.executeValue(root, input, { field: "application.terminal_phone", value: "13900000000" })).ok, false);
  assert.equal(focused, false);
  input.readOnly = false;
  assert.equal((await writer.executeValue(root, input, { field: "application.terminal_phone", value: "13900000000" })).ok, true);
  assert.equal(input.value, "13900000000");
  assert.equal(focused, true);
});

test("single-field writer enforces the scrap field allowlist and collected value", async () => {
  const writer = loadWriter({ setTimeout });
  const input = valueInput("VIN-OLD");
  const root = { defaultView: { Event: class Event {} } };

  const denied = await writer.executeValue(root, input, { field: "application.customer_name", value: "张三", expectedValue: "" });
  assert.equal(denied.ok, false);
  assert.equal(input.value, "VIN-OLD");

  const stale = await writer.executeValue(root, input, { field: "new_vehicle.vin", value: "VIN-NEW", expectedValue: "VIN-OTHER" });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /当前值与采集时不同/);
  assert.equal(input.value, "VIN-OLD");
});

test("single-field writer restores the original value after failed readback", async () => {
  const input = valueInput("VIN-OLD");
  let events = 0;
  input.dispatchEvent = () => {
    events += 1;
    if (events <= 2) input.value = "FRAMEWORK-REJECTED";
  };
  const result = await loadWriter({ setTimeout }).executeValue(
    { defaultView: { Event: class Event {} } },
    input,
    { field: "new_vehicle.vin", value: "VIN-NEW", expectedValue: "VIN-OLD" },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /回读失败/);
  assert.equal(input.value, "VIN-OLD");
});

test("invoice amount accepts the page currency formatting during readback", async () => {
  const input = valueInput("￥");
  input.dispatchEvent = (event) => {
    if (event.type === "change") input.value = "￥423,000.00";
  };

  const result = await loadWriter({ setTimeout }).executeValue(
    { defaultView: { Event: class Event { constructor(type) { this.type = type; } } } },
    input,
    { field: "invoice.amount", value: "423000.00", expectedValue: "" },
  );

  assert.equal(result.ok, true);
  assert.equal(input.value, "￥423,000.00");
  assert.equal(result.actions[0].value, "￥423,000.00");
});
