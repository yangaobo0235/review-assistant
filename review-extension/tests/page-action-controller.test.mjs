import assert from "node:assert/strict";
import test from "node:test";
import { PageActionController } from "../src/session/pageActionController.ts";

test("fill then focuses without changing review status", async () => {
  const calls = [];
  const controller = new PageActionController({
    async fill(request) { calls.push(["fill", request.field]); return { status: "SUCCEEDED", field: request.field }; },
    async focus(field) { calls.push(["focus", field]); return { status: "SUCCEEDED", field }; },
  });
  const result = await controller.fillAndLocate({ field: "new_vehicle.vin", value: "VIN", pageInstanceId: "p1" });
  assert.deepEqual(calls, [["fill", "new_vehicle.vin"], ["focus", "new_vehicle.vin"]]);
  assert.equal(result.highlighted, true);
});

test("a failed fill releases the controller for later actions", async () => {
  let attempts = 0;
  const controller = new PageActionController({
    async fill(request) { attempts += 1; return { status: attempts === 1 ? "FAILED" : "SUCCEEDED", field: request.field }; },
    async focus(field) { return { status: "SUCCEEDED", field }; },
  });
  assert.equal((await controller.fillAndLocate({ field: "x", value: "1", pageInstanceId: "p" })).status, "FAILED");
  assert.equal((await controller.fillAndLocate({ field: "x", value: "1", pageInstanceId: "p" })).status, "SUCCEEDED");
});
