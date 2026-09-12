/** Only fill explicit scrap-replacement targets; affiliation keeps its joint atomic path. */
(() => {
  const ALLOWED_TARGETS = Object.freeze({ "old_vehicle.affiliation": "报废车挂靠", "new_vehicle.affiliation": "新车挂靠" });
  const ALLOWED_VALUE_FIELDS = Object.freeze(new Set([
    "old_vehicle.recycle_date", "scrap_certificate.certificate_no", "old_vehicle.vin", "old_vehicle.plate_no", "old_vehicle.owner", "old_vehicle.engine_model",
    "invoice.code", "invoice.invoice_no", "invoice.amount", "invoice.invoice_date", "new_vehicle.vin", "new_vehicle.plate_no", "new_vehicle.owner",
  ]));
  const OWNER_OPTIONS = Object.freeze({ PERSONAL: ["个人"], COMPANY: ["公司", "企业"] });
  const ITEM_SELECTOR = ".ant-form-item, .el-form-item, .form-item";
  const LABEL_SELECTOR = ".ant-form-item-label label, .el-form-item__label, label";
  const COMBOBOX_SELECTOR = "[role='combobox'], input[aria-controls], input[aria-owns]";
  const OPTION_SELECTOR = ".ant-select-item-option, .el-select-dropdown__item, [role='option']";
  const normalize = (value) => String(value || "").replace(/[＊*]/g, "").replace(/\s+/g, "").replace(/[：:]$/, "");
  const text = (element) => String(element?.innerText ?? element?.textContent ?? "").trim();
  const queryAll = (root, selector) => Array.from(root?.querySelectorAll?.(selector) || []);
  const connected = (element) => element?.isConnected !== false;
  const hidden = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden === true || node.getAttribute?.("aria-hidden") === "true" || node.style?.display === "none" || node.style?.visibility === "hidden") return true;
      const getComputedStyle = node.ownerDocument?.defaultView?.getComputedStyle;
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle.call(node.ownerDocument.defaultView, node);
        if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return true;
      }
    }
    return false;
  };
  const disabled = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (node.disabled === true || node.getAttribute?.("aria-disabled") === "true") return true;
    }
    return false;
  };
  const writable = (element, custom = false) => connected(element) && !hidden(element) && !disabled(element) && (custom || (element?.readOnly !== true && element?.getAttribute?.("readonly") == null));

  function fieldItems(root, label) {
    return queryAll(root, ITEM_SELECTOR).filter((item) => normalize(text(item.querySelector?.(LABEL_SELECTOR))) === normalize(label));
  }

  function resolveControl(root, action) {
    const items = fieldItems(root, action.target_label);
    if (items.length !== 1) return { error: items.length ? `${action.target_label}存在重复控件，已停止填写` : `未找到${action.target_label}控件` };
    const item = items[0];
    if (!writable(item, true)) return { error: `${action.target_label}控件不可写或已变化，页面已刷新` };
    const nativeControls = queryAll(item, "select");
    const combos = queryAll(item, COMBOBOX_SELECTOR);
    if (nativeControls.length + combos.length > 1) return { error: `${action.target_label}存在多个逻辑控件，已停止填写` };
    if (nativeControls.length === 1) {
      const nativeSelect = nativeControls[0];
      if (!writable(nativeSelect)) return { error: `${action.target_label}控件不可写或已变化，页面已刷新` };
      return { item, control: nativeSelect, nativeSelect };
    }
    if (combos.length !== 1) return { error: combos.length ? `${action.target_label}存在多个逻辑控件，已停止填写` : `未找到${action.target_label}可写控件` };
    const control = combos[0];
    if (!writable(control, true)) return { error: `${action.target_label}控件不可写或已变化，页面已刷新` };
    const listboxId = control.getAttribute?.("aria-controls") || control.getAttribute?.("aria-owns");
    if (!listboxId || /\s/.test(listboxId)) return { error: `${action.target_label}下拉选项无法可靠关联` };
    return { item, control, listboxId };
  }

  function nativeCurrent(select) {
    const value = String(select.value ?? "");
    if (!value) return { value: "", label: "" };
    const selected = Array.from(select.options || []).find((option) => String(option.value ?? text(option)) === value);
    return { value, label: text(selected) || value };
  }

  function currentValue(resolved) {
    if (resolved.nativeSelect) return nativeCurrent(resolved.nativeSelect).label;
    return String(resolved.control?.value ?? "").trim() || text(resolved.item.querySelector?.(".ant-select-selection-item, .el-select__selected-item, .el-input__inner"));
  }

  function matchingOptions(options, ownerType) {
    const aliases = OWNER_OPTIONS[ownerType] || [];
    return options.filter((item) => writable(item) && aliases.includes(normalize(text(item))));
  }

  function nativeOptions(resolved, ownerType) { return matchingOptions(Array.from(resolved.nativeSelect?.options || []), ownerType); }
  const settle = () => globalThis.setTimeout ? new Promise((resolve) => globalThis.setTimeout(resolve, 0)) : Promise.resolve();

  const guardError = "页面已变化，请重新审核";
  const sameCollectedRecord = (guard) => typeof guard !== "function" || guard();

  async function customOptions(root, resolved, ownerType, closeAfter, guard) {
    if (!sameCollectedRecord(guard)) return { error: guardError };
    let listbox = root?.getElementById?.(resolved.listboxId);
    resolved.control.click?.();
    let matches = [];
    for (let attempt = 0; attempt < 3 && matches.length === 0; attempt += 1) {
      await settle();
      if (!sameCollectedRecord(guard)) return { error: guardError };
      listbox = root?.getElementById?.(resolved.listboxId);
      if (listbox && connected(listbox) && !hidden(listbox)) matches = matchingOptions(queryAll(listbox, OPTION_SELECTOR), ownerType);
    }
    if (closeAfter) {
      resolved.control.click?.();
      await settle();
      if (!sameCollectedRecord(guard)) return { error: guardError };
    }
    return { options: matches };
  }

  function validateActions(actions) {
    if (!Array.isArray(actions) || actions.length !== 2) return "挂靠填写意图不完整，已停止填写";
    const fields = new Set();
    for (const action of actions) {
      if (!action || ALLOWED_TARGETS[action.field] !== action.target_label || !OWNER_OPTIONS[action.owner_type] || fields.has(action.field)) return "检测到不允许自动填写的页面字段";
      fields.add(action.field);
    }
    return fields.size === Object.keys(ALLOWED_TARGETS).length ? null : "挂靠填写意图不完整，已停止填写";
  }

  function validatePendingState(root, actions, expected = new Map(), guard) {
    if (!sameCollectedRecord(guard)) return { error: guardError };
    for (const action of actions) {
      const resolved = resolveControl(root, action);
      if (resolved.error) return { error: resolved.error };
      const original = expected.get(action.field);
      if (original && (original.item !== resolved.item || original.control !== resolved.control)) return { error: `${action.target_label}控件已变化，页面已刷新` };
      if (currentValue(resolved)) return { error: `${action.target_label}已有值，禁止覆盖` };
    }
    return {};
  }

  async function validatePending(root, actions, expected = new Map(), guard) {
    const currentState = validatePendingState(root, actions, expected, guard);
    if (currentState.error) return currentState;
    const prepared = [];
    for (const action of actions) {
      const resolved = resolveControl(root, action);
      const result = resolved.nativeSelect
        ? { options: nativeOptions(resolved, action.owner_type) }
        : await customOptions(root, resolved, action.owner_type, true, guard);
      if (result.error) return result;
      const options = result.options;
      if (options.length !== 1) return { error: `${action.target_label}的个人/公司选项${options.length ? "存在歧义" : "不存在"}` };
      prepared.push({ action, resolved });
    }
    return { prepared };
  }

  async function preflight(root, actions, guard) {
    const validationError = validateActions(actions);
    return validationError ? { error: validationError } : validatePending(root, actions, new Map(), guard);
  }

  function dispatchNative(select, root) {
    const EventClass = root?.defaultView?.Event || globalThis.Event;
    if (!EventClass) return;
    select.dispatchEvent?.(new EventClass("input", { bubbles: true }));
    select.dispatchEvent?.(new EventClass("change", { bubbles: true }));
  }

  async function fillOne(root, action, expected, pendingActions, expectedControls, guard) {
    if (!sameCollectedRecord(guard)) return { error: guardError };
    const resolved = resolveControl(root, action);
    if (resolved.error || expected.item !== resolved.item || expected.control !== resolved.control || currentValue(resolved)) return { error: resolved.error || `${action.target_label}控件已变化或已有值，禁止覆盖` };
    if (resolved.nativeSelect) {
      const options = nativeOptions(resolved, action.owner_type);
      if (options.length !== 1) return { error: `${action.target_label}选项已变化` };
      const pendingState = validatePendingState(root, pendingActions, expectedControls, guard);
      if (pendingState.error) return pendingState;
      const choice = options[0];
      resolved.nativeSelect.value = String(choice.value ?? text(choice));
      choice.selected = true;
      dispatchNative(resolved.nativeSelect, root);
    } else {
      const optionResult = await customOptions(root, resolved, action.owner_type, false, guard);
      if (optionResult.error) return optionResult;
      const pendingState = validatePendingState(root, pendingActions, expectedControls, guard);
      if (pendingState.error) return pendingState;
      const options = optionResult.options;
      const fresh = resolveControl(root, action);
      if (fresh.error || fresh.item !== expected.item || fresh.control !== expected.control || currentValue(fresh) || options.length !== 1 || !writable(options[0])) return { error: `${action.target_label}选项或控件已变化，禁止覆盖` };
      if (!sameCollectedRecord(guard)) return { error: guardError };
      options[0].click?.();
      await settle();
      if (!sameCollectedRecord(guard)) return { error: guardError, wrote: true };
    }
    const refreshed = resolveControl(root, action);
    if (refreshed.error) return { error: `${action.target_label}控件已变化，页面已刷新`, wrote: true };
    if (!OWNER_OPTIONS[action.owner_type].includes(normalize(currentValue(refreshed)))) return { error: `${action.target_label}写入后回读失败`, wrote: true };
    return { status: "FILLED", field: action.field, label: action.target_label, value: normalize(currentValue(refreshed)) };
  }

  // 回滚只恢复本次调用写入过的两个挂靠字段的原值；同样走受控写入路径并遵守字段白名单。
  const CLEAR_SELECTOR = ".ant-select-clear, .ant-select-clear-icon, .el-select__clear, .el-input__clear";

  function snapshotValue(resolved) {
    if (resolved.nativeSelect) {
      return {
        label: nativeCurrent(resolved.nativeSelect).label,
        raw: String(resolved.nativeSelect.value ?? ""),
        selected: Array.from(resolved.nativeSelect.options || []).filter((option) => option.selected === true),
      };
    }
    return { label: currentValue(resolved) };
  }

  async function restoreCustomOption(root, resolved, targetLabel, label, guard) {
    resolved.control.click?.();
    let target = null;
    for (let attempt = 0; attempt < 3 && !target; attempt += 1) {
      await settle();
      if (!sameCollectedRecord(guard)) return guardError;
      const listbox = root?.getElementById?.(resolved.listboxId);
      if (listbox && connected(listbox) && !hidden(listbox)) target = queryAll(listbox, OPTION_SELECTOR).find((item) => writable(item) && normalize(text(item)) === normalize(label)) || null;
    }
    if (!target) {
      resolved.control.click?.();
      await settle();
      return `${targetLabel}无法恢复原值，回滚失败`;
    }
    target.click?.();
    return null;
  }

  async function restoreControl(root, entry, guard) {
    const { action, resolved, original } = entry;
    if (!ALLOWED_TARGETS[action.field]) return `${action.field}不在允许写入的字段内`;
    if (!sameCollectedRecord(guard)) return guardError;
    const fresh = resolveControl(root, action);
    if (fresh.error || fresh.item !== resolved.item || fresh.control !== resolved.control) return `${action.target_label}控件已变化，回滚失败`;
    if (normalize(currentValue(fresh)) !== normalize(original.label)) {
      if (fresh.nativeSelect) {
        fresh.nativeSelect.value = original.raw;
        for (const option of Array.from(fresh.nativeSelect.options || [])) option.selected = original.selected.includes(option);
        dispatchNative(fresh.nativeSelect, root);
      } else if (!original.label) {
        const clear = fresh.item.querySelector?.(CLEAR_SELECTOR);
        if (!clear || !writable(clear, true)) return `${action.target_label}无法自动清空，回滚失败`;
        clear.click?.();
      } else {
        const restoreError = await restoreCustomOption(root, fresh, action.target_label, original.label, guard);
        if (restoreError) return restoreError;
      }
    }
    await settle();
    if (!sameCollectedRecord(guard)) return guardError;
    const after = resolveControl(root, action);
    if (after.error || normalize(currentValue(after)) !== normalize(original.label)) return `${action.target_label}回滚后回读失败`;
    return null;
  }

  async function execute(root, actions, guard) {
    const checked = await preflight(root, actions, guard);
    if (checked.error) return { ok: false, message: checked.error, actions: [] };
    const originals = new Map(checked.prepared.map((item) => [item.action.field, item.resolved]));
    const snapshot = new Map(checked.prepared.map((item) => [item.action.field, { action: item.action, resolved: item.resolved, original: snapshotValue(item.resolved) }]));
    const written = [];
    const results = [];
    // 全有或全无：任一写入或回读失败时回滚本次调用已写入的字段；身份失效则立即停止一切写入。
    const fail = async (message) => {
      if (!written.length) return { ok: false, message, actions: [] };
      if (!sameCollectedRecord(guard)) return { ok: false, message: `${message}；页面身份已失效，已停止回滚写入`, actions: [] };
      const errors = [];
      for (const field of [...written].reverse()) {
        const error = await restoreControl(root, snapshot.get(field), guard);
        if (error) errors.push(error);
      }
      return errors.length
        ? { ok: false, message: `${message}；自动回滚未完成（${errors.join("；")}），请人工核对页面`, actions: [] }
        : { ok: false, message: `${message}；已回滚`, actions: [] };
    };
    for (let index = 0; index < actions.length; index += 1) {
      const pendingActions = actions.slice(index);
      const pending = await validatePending(root, pendingActions, originals, guard);
      if (pending.error) return await fail(pending.error);
      const action = actions[index];
      const result = await fillOne(root, action, originals.get(action.field), pendingActions, originals, guard);
      if (result.error) {
        if (result.wrote) written.push(action.field);
        return await fail(result.error);
      }
      written.push(action.field);
      results.push(result);
    }
    return { ok: true, message: "挂靠字段已填写并回读", actions: results };
  }

  function writableValueControl(entry) {
    if (!entry) return null;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(entry.tagName)) return entry;
    return entry.querySelector?.("input, textarea, select") || null;
  }

  function dispatchValue(control, value, root) {
    const EventClass = root?.defaultView?.Event || globalThis.Event;
    if (control.tagName === "SELECT") {
      const options = Array.from(control.options || []).filter((option) => normalize(text(option)) === normalize(value));
      if (options.length !== 1) return "页面选项不存在或存在歧义";
      control.value = String(options[0].value ?? text(options[0]));
    } else {
      const prototype = control.tagName === "TEXTAREA" ? root.defaultView?.HTMLTextAreaElement?.prototype : root.defaultView?.HTMLInputElement?.prototype;
      const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(control, value); else control.value = value;
    }
    if (EventClass) {
      control.dispatchEvent?.(new EventClass("input", { bubbles: true }));
      control.dispatchEvent?.(new EventClass("change", { bubbles: true }));
    }
    return null;
  }

  function readValueControl(control) {
    if (control.tagName === "SELECT") return nativeCurrent(control).label;
    return String(control.value ?? text(control)).trim();
  }

  async function executeValue(root, entry, action, guard) {
    if (!action || !ALLOWED_VALUE_FIELDS.has(action.field)) return { ok: false, message: "该字段不在报废置换允许回填范围内" };
    if (!entry || !sameCollectedRecord(guard)) return { ok: false, message: guardError };
    const control = writableValueControl(entry);
    if (!control || !writable(control, true)) return { ok: false, message: "目标字段不可写或页面已变化" };
    const original = readValueControl(control);
    const originalRaw = control.tagName === "SELECT" ? String(control.value ?? "") : original;
    if (action.expectedValue != null && normalize(original) !== normalize(action.expectedValue)) {
      return { ok: false, message: "页面原值已变化，请重新采集" };
    }
    const error = dispatchValue(control, action.value, root);
    if (error) return { ok: false, message: error };
    await settle();
    if (!sameCollectedRecord(guard)) return { ok: false, message: guardError };
    const after = readValueControl(control);
    if (normalize(after) !== normalize(action.value)) {
      if (sameCollectedRecord(guard)) {
        if (control.tagName === "SELECT") {
          control.value = originalRaw;
          dispatchNative(control, root);
        } else {
          dispatchValue(control, original, root);
        }
      }
      return { ok: false, message: "回填后回读失败" };
    }
    return { ok: true, message: "字段已回填并回读", actions: [{ field: action.field, label: action.field, value: after, status: "FILLED" }] };
  }

  globalThis.ReviewPageFieldWriter = { execute, preflight, executeValue };
})();
