import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadMatcher() {
  const source = readFileSync(new URL("../public/field-matcher.js", import.meta.url), "utf8");
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  return context.globalThis.ReviewFieldMatcher;
}

test("old vehicle VIN prefers its exact label over a generic new vehicle match", () => {
  const matcher = loadMatcher();
  const selected = matcher.select("old_vehicle.vin", ["报废车辆车架号", "旧车车架号"], [
    { value: "NEW-VIN", label: "新车车架号", context: "新车车架号", section: "new_vehicle" },
    { value: "OLD-VIN", label: "报废车辆车架号", context: "报废车辆车架号", section: "old_vehicle" },
  ]);

  assert.equal(selected.value, "OLD-VIN");
});

test("old vehicle field rejects a candidate from the new vehicle section", () => {
  const matcher = loadMatcher();
  const selected = matcher.select("old_vehicle.plate_no", ["报废车辆车牌号"], [
    {
      value: "NEW-PLATE",
      label: "",
      context: "报废车辆车牌号 新车车牌号",
      section: "new_vehicle",
    },
  ]);

  assert.equal(selected, null);
});
