import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("page writes use the collection identity and the unified fill intent", () => {
  const source = readFileSync(new URL("../src/browser/content.ts", import.meta.url), "utf8");
  assert.match(source, /sameReviewIdentity\(message\)/);
  assert.match(source, /APPLY_PAGE_FILL_INTENT/);
});
