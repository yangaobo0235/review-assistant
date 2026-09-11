import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const markerSource = readFileSync(
  new URL("../public/page-review-marker.js", import.meta.url),
  "utf8",
);

/** Minimal DOM double: markers only use createElement, attributes, inline styles, and listeners. */
const setConnected = (node, value) => {
  node.isConnected = value;
  for (const child of node.childNodes) setConnected(child, value);
};

const descendants = (node) =>
  node.childNodes.flatMap((child) => [child, ...descendants(child)]);

function matches(node, selector) {
  const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attribute) {
    const [, name, value] = attribute;
    return value === undefined
      ? node.attributes.has(name)
      : node.attributes.get(name) === value;
  }
  if (selector.startsWith(".")) {
    return node.className.split(/\s+/).includes(selector.slice(1));
  }
  return node.tagName === selector.toUpperCase();
}

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.listeners = new Map();
    this.events = [];
    this.scrollCalls = [];
    this.disabled = false;
    this.isConnected = false;
    this.ownText = "";
  }

  get textContent() {
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.ownText = String(value);
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }

  get className() {
    return this.getAttribute("class") || "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    setConnected(child, this.isConnected);
    return child;
  }

  insertAdjacentElement(position, node) {
    if (position !== "afterend" || !this.parentNode) {
      throw new Error(`unsupported insertion ${position}`);
    }
    const siblings = this.parentNode.childNodes;
    node.parentNode = this.parentNode;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
    setConnected(node, this.parentNode.isConnected);
    return node;
  }

  remove() {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
    setConnected(this, false);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatchEvent(event) {
    this.events.push(event.type);
    for (const handler of this.listeners.get(event.type) || []) handler.call(this, event);
    return true;
  }

  click() {
    this.dispatchEvent({ type: "click" });
  }

  scrollIntoView(options) {
    this.scrollCalls.push(options);
  }

  querySelectorAll(selector) {
    return descendants(this).filter((node) => matches(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function createFakeDocument() {
  const document = {
    body: null,
    createElement(tagName) {
      return new FakeNode(tagName, document);
    },
    querySelectorAll(selector) {
      return document.body.querySelectorAll(selector);
    },
    querySelector(selector) {
      return document.body.querySelector(selector);
    },
  };
  document.body = new FakeNode("body", document);
  document.body.isConnected = true;
  return document;
}

function loadMarker(document) {
  const context = { globalThis: { document } };
  vm.runInNewContext(markerSource, context);
  return context.globalThis.ReviewPageMarker;
}

function setup() {
  const document = createFakeDocument();
  const marker = loadMarker(document);
  const hostPageNode = document.createElement("div");
  document.body.appendChild(hostPageNode);
  const decisions = [];
  const fakeInput = (value) => {
    const input = document.createElement("input");
    input.value = value;
    hostPageNode.appendChild(input);
    return input;
  };
  const buttons = () => document.querySelectorAll("button");
  const findMarker = (stepId) =>
    document.querySelector(`[data-review-assistant-marker="${stepId}"]`);
  const clickButton = (label) => {
    const button = buttons().find((node) => node.textContent === label);
    assert.ok(button, `missing button ${label}`);
    button.click();
    return button;
  };
  return {
    document,
    marker,
    hostPageNode,
    fakeInput,
    decisions,
    buttons,
    findMarker,
    buttonLabels: () => buttons().map((button) => button.textContent),
    clickButton,
  };
}

const pageStep = (overrides) => ({
  step_id: "FIELD-old_vehicle.vin",
  sequence: 3,
  category: "FIELD",
  display_target: "PAGE_FIELD",
  page_field: "old_vehicle.vin",
  requires_reviewer_action: false,
  label: "报废车辆车架号",
  result_status: "MATCH",
  reason: "页面与登记证书一致",
  values: [{ source: "page", value: "VIN-1" }],
  evidence: [],
  ...overrides,
});

const matchStep = pageStep({});
const insufficientStep = pageStep({
  step_id: "FIELD-invoice.amount",
  page_field: "invoice.amount",
  label: "开票金额",
  requires_reviewer_action: true,
  result_status: "INSUFFICIENT",
  reason: "发票金额识别置信度不足，请人工确认页面金额是否与发票一致",
});
const conflictStep = pageStep({
  step_id: "FIELD-new_vehicle.vin",
  page_field: "new_vehicle.vin",
  label: "新车车架号",
  requires_reviewer_action: true,
  result_status: "CONFLICT",
  reason: "页面车架号与合格证冲突",
});

test("match adds a persistent success marker without changing the field", () => {
  const { marker, fakeInput, findMarker } = setup();
  const input = fakeInput("VIN-1");

  const result = marker.show(input, matchStep, () => {});

  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(input.value, "VIN-1");
  assert.equal(findMarker(matchStep.step_id).textContent, "核验成功");
  assert.equal(findMarker(matchStep.step_id).getAttribute("data-review-assistant-marker"), matchStep.step_id);
  assert.equal(findMarker(matchStep.step_id).querySelectorAll("button").length, 0);

  // A repeated MATCH render stays a button-less success tag.
  marker.show(input, matchStep, () => {});
  assert.equal(findMarker(matchStep.step_id).textContent, "核验成功");
});

test("an uncertain field pauses with two decisions and no continue button", () => {
  const { marker, fakeInput, decisions, buttonLabels, clickButton } = setup();

  marker.show(fakeInput("VIN-1"), insufficientStep, (decision) => decisions.push(decision));

  assert.deepEqual(buttonLabels(), ["确认无误", "标记异常"]);
  clickButton("确认无误");
  assert.deepEqual(decisions, ["CONFIRMED"]);
  assert.equal(buttonLabels().length, 0);
});

test("an anomaly with the action flag off keeps the backend palette instead of success", () => {
  const { marker, fakeInput, findMarker } = setup();
  const matchInput = fakeInput("VIN-0");
  const conflictInput = fakeInput("VIN-8");
  const insufficientInput = fakeInput("VIN-9");
  const handledConflict = pageStep({
    step_id: "FIELD-handled.conflict",
    requires_reviewer_action: false,
    result_status: "CONFLICT",
    reason: "页面车架号与合格证冲突",
  });
  const handledInsufficient = pageStep({
    step_id: "FIELD-handled.insufficient",
    requires_reviewer_action: false,
    result_status: "INSUFFICIENT",
    reason: "发票金额识别置信度不足",
  });

  marker.show(matchInput, matchStep, () => {});
  marker.show(conflictInput, handledConflict, () => {});
  marker.show(insufficientInput, handledInsufficient, () => {});

  const matchRoot = findMarker(matchStep.step_id);
  const conflictRoot = findMarker(handledConflict.step_id);
  const insufficientRoot = findMarker(handledInsufficient.step_id);

  // Without the action flag there are still no buttons and no scroll...
  assert.equal(conflictRoot.querySelectorAll("button").length, 0);
  assert.equal(insufficientRoot.querySelectorAll("button").length, 0);
  assert.deepEqual(conflictInput.scrollCalls, []);
  assert.deepEqual(insufficientInput.scrollCalls, []);

  // ...but the tag must never read or look like a success.
  assert.doesNotMatch(conflictRoot.textContent, /核验成功/);
  assert.doesNotMatch(insufficientRoot.textContent, /核验成功/);
  assert.equal(conflictRoot.querySelector(".review-assistant-marker__status").textContent, "存在冲突");
  assert.equal(insufficientRoot.querySelector(".review-assistant-marker__status").textContent, "证据不足");

  // Palette follows result_status: identical to the actionable rendering, never the MATCH green.
  const actionableConflict = pageStep({
    step_id: "FIELD-actionable.conflict",
    requires_reviewer_action: true,
    result_status: "CONFLICT",
    reason: "页面车架号与合格证冲突",
  });
  marker.show(fakeInput("VIN-7"), actionableConflict, () => {});
  const actionableRoot = findMarker(actionableConflict.step_id);
  assert.equal(conflictRoot.style.color, actionableRoot.style.color);
  assert.equal(conflictRoot.style.backgroundColor, actionableRoot.style.backgroundColor);
  assert.equal(conflictRoot.style.border, actionableRoot.style.border);
  assert.notEqual(conflictRoot.style.backgroundColor, matchRoot.style.backgroundColor);
  assert.notEqual(insufficientRoot.style.backgroundColor, matchRoot.style.backgroundColor);
});

test("records only the first click and marks an exception immediately", () => {
  const { marker, fakeInput, decisions, buttonLabels, clickButton } = setup();

  marker.show(fakeInput("VIN-2"), conflictStep, (decision) => decisions.push(decision));
  const marked = clickButton("标记异常");
  assert.equal(marked.disabled, true);
  assert.deepEqual(decisions, ["MARKED_EXCEPTION"]);

  // The removed action area cannot accept a second decision, even from a stale reference.
  marked.click();
  assert.deepEqual(decisions, ["MARKED_EXCEPTION"]);
  assert.equal(buttonLabels().length, 0);
});

test("clear removes only extension-owned nodes", () => {
  const { marker, fakeInput, hostPageNode, document } = setup();
  marker.show(fakeInput("VIN-1"), matchStep, () => {});
  marker.show(fakeInput("VIN-2"), conflictStep, () => {});

  marker.clear();

  assert.equal(hostPageNode.isConnected, true);
  assert.equal(document.querySelectorAll("[data-review-assistant-marker]").length, 0);
});

test("clear keeps a host node that happens to carry the marker attribute", () => {
  const { marker, fakeInput, hostPageNode, document } = setup();
  marker.show(fakeInput("VIN-1"), matchStep, () => {});
  const hostNode = document.createElement("span");
  hostNode.setAttribute("data-review-assistant-marker", "host-owned");
  hostPageNode.appendChild(hostNode);

  marker.clear();

  assert.equal(hostNode.isConnected, true);
  assert.equal(document.querySelectorAll("[data-review-assistant-marker]").length, 1);
});

test("complete freezes the decision into the marker and drops the buttons", () => {
  const { marker, fakeInput, findMarker, buttonLabels } = setup();
  marker.show(fakeInput("VIN-2"), conflictStep, () => {});

  const result = marker.complete(conflictStep.step_id, "MARKED_EXCEPTION");
  const frozen = findMarker(conflictStep.step_id);

  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(buttonLabels().length, 0);
  assert.equal(frozen.isConnected, true);
  assert.match(frozen.textContent, /已标记异常/);
  assert.match(frozen.textContent, /页面车架号与合格证冲突/);
  assert.equal(frozen.getAttribute("data-review-assistant-decision"), "MARKED_EXCEPTION");
});

test("complete records a manual confirmation without claiming a backend match", () => {
  const { marker, fakeInput, findMarker } = setup();
  marker.show(fakeInput("VIN-3"), insufficientStep, () => {});

  marker.complete(insufficientStep.step_id, "CONFIRMED");

  const frozen = findMarker(insufficientStep.step_id);
  assert.match(frozen.textContent, /已确认无误/);
  assert.doesNotMatch(frozen.textContent, /核验成功/);
  assert.equal(frozen.querySelectorAll("button").length, 0);
});

test("complete keeps a match marker as a persistent success tag", () => {
  const { marker, fakeInput, findMarker } = setup();
  marker.show(fakeInput("VIN-1"), matchStep, () => {});

  marker.complete(matchStep.step_id, undefined);

  assert.equal(findMarker(matchStep.step_id).textContent, "核验成功");
  assert.equal(findMarker(matchStep.step_id).isConnected, true);
});

test("complete reports a marker that no longer exists instead of recreating it", () => {
  const { marker, findMarker, document } = setup();

  const result = marker.complete("FIELD-missing", "CONFIRMED");

  assert.equal(result.ok, false);
  assert.match(result.error || "", /重新审核|已失效/);
  assert.equal(document.querySelectorAll("[data-review-assistant-marker]").length, 0);
  assert.equal(findMarker("FIELD-missing"), null);
});

test("refuses a detached target and creates no node", () => {
  const { marker, fakeInput, document } = setup();
  const input = fakeInput("VIN-1");
  input.remove();

  const result = marker.show(input, matchStep, () => {});

  assert.deepEqual({ ...result }, { ok: false, error: "页面字段已变化，请重新审核" });
  assert.equal(document.querySelectorAll("[data-review-assistant-marker]").length, 0);
});

test("scrolls only fields that wait for a reviewer", () => {
  const { marker, fakeInput } = setup();
  const matched = fakeInput("VIN-1");
  const uncertain = fakeInput("VIN-2");

  marker.show(matched, matchStep, () => {});
  marker.show(uncertain, conflictStep, () => {});

  assert.deepEqual(matched.scrollCalls, []);
  // The options object crosses a vm realm boundary, so copy it before a strict compare.
  assert.deepEqual(uncertain.scrollCalls.map((call) => ({ ...call })), [{ behavior: "smooth", block: "center" }]);
});

test("re-showing one step replaces its marker instead of duplicating it", () => {
  const { marker, fakeInput, document } = setup();
  const input = fakeInput("VIN-2");

  marker.show(input, conflictStep, () => {});
  marker.show(input, conflictStep, () => {});

  const nodes = document.querySelectorAll(`[data-review-assistant-marker="${conflictStep.step_id}"]`);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].querySelectorAll("button").length, 2);
});

test("keeps several step markers on the page at the same time", () => {
  const { marker, fakeInput, document } = setup();

  marker.show(fakeInput("VIN-1"), matchStep, () => {});
  marker.show(fakeInput("VIN-2"), conflictStep, () => {});
  marker.show(fakeInput("VIN-3"), insufficientStep, () => {});

  assert.equal(document.querySelectorAll("[data-review-assistant-marker]").length, 3);
  assert.equal(document.querySelectorAll("button").length, 4);
});

test("never writes the host field, its attributes, or its events", () => {
  const { marker, fakeInput, hostPageNode } = setup();
  const input = fakeInput("VIN-2");

  marker.show(input, conflictStep, () => {});
  marker.complete(conflictStep.step_id, "CONFIRMED");
  marker.clear();

  assert.equal(input.value, "VIN-2");
  assert.deepEqual(input.events, []);
  assert.equal(input.attributes.size, 0);
  assert.deepEqual({ ...input.style }, {});
  assert.deepEqual({ ...hostPageNode.style }, {});
  assert.equal(input.disabled, false);
});

test("marker source never assigns values, dispatches events, or clicks host controls", () => {
  assert.doesNotMatch(markerSource, /\.value\s*=/);
  assert.doesNotMatch(markerSource, /dispatchEvent/);
  assert.doesNotMatch(markerSource, /\.click\s*\(/);
  assert.doesNotMatch(markerSource, /insertAdjacentHTML|innerHTML\s*=/);
  assert.match(markerSource, /data-review-assistant-marker/);
});

test("renders the reason with wrapping and isolated inline styling", () => {
  const { marker, fakeInput, findMarker } = setup();
  marker.show(fakeInput("VIN-3"), insufficientStep, () => {});

  const root = findMarker(insufficientStep.step_id);
  const reason = root.querySelector(".review-assistant-marker__reason");

  assert.equal(reason.textContent, insufficientStep.reason);
  assert.equal(reason.style.overflowWrap, "anywhere");
  assert.equal(reason.style.wordBreak, "break-word");
  assert.equal(root.style.display, "inline-flex");
  assert.equal(root.style.boxSizing, "border-box");
  assert.equal(root.style.maxWidth, "100%");
  // The marker shrinks and wraps instead of squeezing the host control inside a flex container.
  assert.equal(root.style.flex, "0 1 auto");
  assert.equal(root.style.minWidth, "0");
  assert.equal(root.style.fontFamily.includes("sans-serif"), true);
  assert.ok(root.style.color);
  assert.ok(root.style.backgroundColor);
  assert.ok(root.style.border);
});

test("gives buttons an explicit height, border, and focus style", () => {
  const { marker, fakeInput, buttons } = setup();
  marker.show(fakeInput("VIN-2"), conflictStep, () => {});
  const [confirmed, flagged] = buttons();

  for (const button of [confirmed, flagged]) {
    assert.equal(button.style.height, "24px");
    assert.ok(button.style.border);
    assert.ok(button.style.backgroundColor);
    assert.ok(button.style.fontFamily.includes("sans-serif"));
    assert.equal(button.getAttribute("type"), "button");

    button.dispatchEvent({ type: "focus" });
    assert.ok(button.style.outline, "focus style missing");
    button.dispatchEvent({ type: "blur" });
    assert.equal(button.style.outline, "");
  }
  assert.notEqual(confirmed.style.color, flagged.style.color);
});

test("exposes show, complete, and clear only", () => {
  const { marker } = setup();
  assert.deepEqual(Object.keys(marker).sort(), ["clear", "complete", "show"]);
});
