import assert from "node:assert/strict";
import test from "node:test";
import { ReviewImageFocus } from "../src/browser/image-focus.ts";

function loadImageFocus() {
  return ReviewImageFocus;
}

test("scrolls to, highlights, and opens the collected image", () => {
  const { focus } = loadImageFocus();
  const scrollCalls = [];
  const events = [];
  const timers = [];
  let clickCount = 0;
  let outlineAtClick = "";
  const image = {
    isConnected: true,
    style: { outline: "1px solid red", outlineOffset: "0px" },
    scrollIntoView(options) {
      scrollCalls.push(options);
      events.push("scroll");
    },
    click() {
      clickCount += 1;
      outlineAtClick = this.style.outline;
      events.push("click");
    },
  };

  const result = focus(image, (callback, delay) => timers.push({ callback, delay }));

  assert.deepEqual({ ...result }, { ok: true });
  assert.deepEqual({ ...scrollCalls[0] }, {
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
  assert.deepEqual(events, ["scroll", "click"]);
  assert.equal(clickCount, 1);
  assert.equal(outlineAtClick, "4px solid #1677ff");
  assert.equal(image.style.outline, "4px solid #1677ff");
  assert.equal(timers[0].delay, 2000);
  timers[0].callback();
  assert.equal(image.style.outline, "1px solid red");
  assert.equal(image.style.outlineOffset, "0px");
});

test("does not click an original image that is no longer connected", () => {
  const { focus } = loadImageFocus();
  let clickCount = 0;
  const image = {
    isConnected: false,
    click() { clickCount += 1; },
  };

  assert.deepEqual({ ...focus(image) }, { ok: false, error: "原图已变化，请重新采集" });
  assert.deepEqual({ ...focus(null) }, { ok: false, error: "原图已变化，请重新采集" });
  assert.equal(clickCount, 0);
});
