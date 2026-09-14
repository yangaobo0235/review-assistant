import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("verified VIN edits preserve collection identity, while an unrelated record change still blocks writes", async () => {
  let handler;
  const input = { tagName: "INPUT", value: "VIN-OLD", isConnected: true, getAttribute: () => null, dispatchEvent() {} };
  const fields = { "application.id": "CASE-1", "new_vehicle.vin": "VIN-NEW" };
  const url = "https://admin.forjtruck.com/scrap-replace-qingdao";
  const context = vm.createContext({
    input, setTimeout,
    crypto: { randomUUID: () => "page-instance" },
    chrome: { runtime: { onMessage: { addListener: (listener) => { handler = listener; } } } },
    window: { location: { href: url } },
    document: { defaultView: { Event: class Event {} } },
    ReviewPageFieldCollector: { collect: () => ({ pageFields: { ...fields, "old_vehicle.vin": input.value } }) },
  });
  for (const file of ["page-field-writer.js", "content.js"]) {
    vm.runInContext(readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"), context);
  }
  vm.runInContext('activeCollectionId = "collection"; reviewFieldElements.set("old_vehicle.vin", {element: input, collectionId: "collection"});', context);
  const fingerprint = vm.runInContext('pageFingerprint(globalThis.ReviewPageFieldCollector.collect().pageFields)', context);
  const fill = (value, expectedValue) => new Promise((resolve) => handler({
    type: "APPLY_PAGE_FIELD_VALUE", action: { field: "old_vehicle.vin", value, expectedValue },
    expectedPageUrl: url, expectedPageInstanceId: "page-instance", expectedCollectionId: "collection", expectedPageFingerprint: fingerprint,
  }, null, resolve));
  assert.equal((await fill("VIN-MANUAL-1", "VIN-OLD")).ok, true);
  assert.equal((await fill("VIN-MANUAL-2", "VIN-MANUAL-1")).ok, true);
  assert.equal(input.value, "VIN-MANUAL-2");
  fields["application.id"] = "CASE-2";
  assert.equal((await fill("VIN-MANUAL-3", "VIN-MANUAL-2")).ok, false);
  assert.equal(input.value, "VIN-MANUAL-2");
});
