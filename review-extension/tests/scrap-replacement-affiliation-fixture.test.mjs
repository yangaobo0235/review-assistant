import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = readFileSync(
  new URL("./fixtures/scrap-replacement-affiliation.html", import.meta.url),
  "utf8",
);
const writer = readFileSync(
  new URL("../public/page-field-writer.js", import.meta.url),
  "utf8",
);

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
