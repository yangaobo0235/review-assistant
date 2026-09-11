/**
 * 功能：在原页面字段旁渲染只读核验标记、原因和人工确认按钮。
 * 职责边界：只创建、更新和清理扩展自己的节点；绝不给宿主字段赋值、派发 input/change 事件，
 *           也绝不点击宿主页面控件。清理只删除本模块登记的节点（spec §5.3）。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

(() => {
  const MARKER_ATTRIBUTE = "data-review-assistant-marker";
  const DECISION_ATTRIBUTE = "data-review-assistant-decision";
  const SUCCESS_TEXT = "核验成功";
  const STATUS_TEXT = Object.freeze({
    MATCH: SUCCESS_TEXT,
    CONFLICT: "存在冲突",
    INSUFFICIENT: "证据不足",
  });
  const DECISION_TEXT = Object.freeze({
    CONFIRMED: "已确认无误",
    MARKED_EXCEPTION: "已标记异常",
  });
  const DECISION_BUTTONS = Object.freeze([
    Object.freeze({ decision: "CONFIRMED", label: "确认无误" }),
    Object.freeze({ decision: "MARKED_EXCEPTION", label: "标记异常" }),
  ]);
  const FONT_FAMILY = "'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif";
  // 状态配色跟随后端结论；人工选择只改文案，不把异常染成成功。
  const PALETTE = Object.freeze({
    MATCH: Object.freeze({ color: "#135200", backgroundColor: "#f6ffed", border: "1px solid #b7eb8f" }),
    CONFLICT: Object.freeze({ color: "#a8071a", backgroundColor: "#fff1f0", border: "1px solid #ffa39e" }),
    INSUFFICIENT: Object.freeze({ color: "#873800", backgroundColor: "#fff7e6", border: "1px solid #ffd591" }),
  });
  const BUTTON_PALETTE = Object.freeze({
    CONFIRMED: Object.freeze({ color: "#135200", backgroundColor: "#f6ffed", border: "1px solid #b7eb8f" }),
    MARKED_EXCEPTION: Object.freeze({ color: "#a8071a", backgroundColor: "#ffffff", border: "1px solid #ffa39e" }),
  });
  const ROOT_STYLE = Object.freeze({
    display: "inline-flex",
    // 标记自己收缩换行，避免在宿主 flex 容器里挤压原字段控件。
    flex: "0 1 auto",
    minWidth: "0",
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: "6px",
    boxSizing: "border-box",
    maxWidth: "100%",
    margin: "2px 0 2px 8px",
    padding: "2px 8px",
    verticalAlign: "middle",
    fontFamily: FONT_FAMILY,
    fontSize: "12px",
    lineHeight: "18px",
    fontWeight: "400",
    textAlign: "left",
    whiteSpace: "normal",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
    borderRadius: "4px",
  });
  const STATUS_STYLE = Object.freeze({ fontWeight: "600", whiteSpace: "nowrap" });
  const REASON_STYLE = Object.freeze({
    flex: "1 1 auto",
    minWidth: "0",
    maxWidth: "100%",
    whiteSpace: "normal",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  });
  const ACTIONS_STYLE = Object.freeze({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
  });
  const BUTTON_STYLE = Object.freeze({
    boxSizing: "border-box",
    height: "24px",
    lineHeight: "20px",
    padding: "0 10px",
    margin: "0",
    fontFamily: FONT_FAMILY,
    fontSize: "12px",
    borderRadius: "3px",
    cursor: "pointer",
    outline: "",
    outlineOffset: "1px",
  });
  const FOCUS_OUTLINE = "2px solid #1677ff";
  const TARGET_ERROR = "页面字段已变化，请重新审核";

  // stepId -> 记录；只有这里登记过的节点才允许被本模块删除。
  const markers = new Map();

  const textFor = (table, key, fallback) =>
    Object.hasOwn(table, key) ? table[key] : fallback;

  const applyStyles = (node, styles) => {
    for (const [property, value] of Object.entries(styles)) node.style[property] = value;
    return node;
  };

  const focusStyle = (button, focused) => {
    button.style.outline = focused ? FOCUS_OUTLINE : "";
    button.style.outlineOffset = focused ? "1px" : "";
  };

  const removeActions = (record) => {
    for (const button of record.buttons) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    }
    record.buttons = [];
    if (record.actions?.parentNode) record.actions.remove();
    record.actions = null;
  };

  const freeze = (record, decision) => {
    record.decided = true;
    removeActions(record);
    const finalText = textFor(DECISION_TEXT, decision, "");
    if (!finalText) return;
    record.status.textContent = finalText;
    record.root.setAttribute(DECISION_ATTRIBUTE, decision);
  };

  const detach = (stepId) => {
    const record = markers.get(stepId);
    if (!record) return;
    markers.delete(stepId);
    record.decided = true;
    record.buttons = [];
    if (record.root?.parentNode) record.root.remove();
  };

  const decide = (record, decision, onDecision) => {
    if (record.decided) return;
    freeze(record, decision);
    if (typeof onDecision === "function") onDecision(decision);
  };

  const buildMarker = (ownerDocument, step, onDecision) => {
    const requiresAction = step.requires_reviewer_action === true;
    // 配色与状态文案只跟随 result_status；requires_reviewer_action 仅决定按钮和滚动，
    // 后端异常即使没有待办动作也不得渲染成无按钮的成功标记。
    const palette = textFor(PALETTE, step.result_status, PALETTE.INSUFFICIENT);
    const root = applyStyles(ownerDocument.createElement("div"), { ...ROOT_STYLE, ...palette });
    root.setAttribute("class", "review-assistant-marker");
    root.setAttribute(MARKER_ATTRIBUTE, String(step.step_id));
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    const status = applyStyles(ownerDocument.createElement("span"), STATUS_STYLE);
    status.setAttribute("class", "review-assistant-marker__status");
    status.textContent = textFor(STATUS_TEXT, step.result_status, "需要人工确认");
    root.appendChild(status);

    const record = {
      root,
      status,
      actions: null,
      buttons: [],
      requiresAction,
      decided: false,
    };

    const reason = String(step.reason ?? "").trim();
    if (requiresAction && reason) {
      const reasonNode = applyStyles(ownerDocument.createElement("span"), REASON_STYLE);
      reasonNode.setAttribute("class", "review-assistant-marker__reason");
      reasonNode.textContent = reason;
      root.appendChild(reasonNode);
    }

    if (requiresAction) {
      record.actions = applyStyles(ownerDocument.createElement("span"), ACTIONS_STYLE);
      record.actions.setAttribute("class", "review-assistant-marker__actions");
      for (const { decision, label } of DECISION_BUTTONS) {
        const button = applyStyles(
          ownerDocument.createElement("button"),
          { ...BUTTON_STYLE, ...BUTTON_PALETTE[decision] },
        );
        button.setAttribute("class", "review-assistant-marker__button");
        button.setAttribute("type", "button");
        button.setAttribute("title", label);
        button.textContent = label;
        button.addEventListener("click", () => decide(record, decision, onDecision));
        button.addEventListener("focus", () => focusStyle(button, true));
        button.addEventListener("blur", () => focusStyle(button, false));
        record.actions.appendChild(button);
        record.buttons.push(button);
      }
      root.appendChild(record.actions);
    }

    return record;
  };

  /** 在字段后插入标记；配色与状态文案跟随 result_status，requires_reviewer_action 只决定按钮与滚动。 */
  function show(target, step, onDecision) {
    if (!target?.isConnected) return { ok: false, error: TARGET_ERROR };
    const stepId = String(step?.step_id ?? "");
    if (!stepId) return { ok: false, error: "审核步骤缺少标识" };
    const ownerDocument = target.ownerDocument || globalThis.document;
    if (typeof ownerDocument?.createElement !== "function") return { ok: false, error: TARGET_ERROR };
    detach(stepId);
    const record = buildMarker(ownerDocument, step, onDecision);
    markers.set(stepId, record);
    try {
      target.insertAdjacentElement("afterend", record.root);
      if (record.requiresAction) target.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      // 宿主容器拒绝插入（例如目标已脱离父节点）时不留下半成品标记。
      detach(stepId);
      return { ok: false, error: TARGET_ERROR };
    }
    return { ok: true };
  }

  /** 固化人工处理结果：移除操作按钮，保留标记，不改写后端结论配色。 */
  function complete(stepId, decision) {
    const key = String(stepId ?? "");
    const record = markers.get(key);
    if (!record) return { ok: false, error: "页面标记已失效，请重新审核" };
    if (!record.root?.isConnected) {
      markers.delete(key);
      return { ok: false, error: TARGET_ERROR };
    }
    freeze(record, decision);
    return { ok: true };
  }

  /** 只删除本模块登记的节点；宿主页面节点即使命名相同也保持不动。 */
  function clear() {
    for (const stepId of [...markers.keys()]) detach(stepId);
    markers.clear();
    return { ok: true };
  }

  globalThis.ReviewPageMarker = Object.freeze({ show, complete, clear });
})();
