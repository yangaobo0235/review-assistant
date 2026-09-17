import type { DomElement, DomRoot } from "./dom.ts";
import type { PageFillAction, PageWriteAction, PageWriteGroupAction } from "../types/review.ts";
type Guard = (() => boolean) | undefined;
interface ResolvedControl {
  item: DomElement; control: DomElement; trigger?: DomElement | null; listboxId?: string | null;
  nativeSelect?: DomElement; radioInputs?: DomElement[]; radioGroup?: DomElement;
  error?: never;
}
type Resolution = ResolvedControl | { error: string; item?: never; control?: never; nativeSelect?: never; radioInputs?: never };
type PopupControl = Pick<ResolvedControl, "control" | "trigger" | "listboxId">;
type GroupPrepared = {
  field: string;
  control: DomElement;
  custom: boolean;
  original: string;
  resolved: PopupControl;
};
type GroupPreparationFailure = {
  error: string;
  code?: string;
  currentValue?: string;
};
type Failure = { error: string; wrote?: boolean };
type Preparation = { error?: never; prepared: { action: PageFillAction; resolved: ResolvedControl }[] } | (Failure & { prepared?: never });
interface OriginalValue { label: string; raw?: string; selectedOptions?: HTMLOptionElement[]; selectedRadio?: DomElement; }
interface RollbackEntry { action: PageFillAction; resolved: ResolvedControl; original: OriginalValue; }

/** Only fill explicit scrap-replacement targets; affiliation keeps its joint atomic path. */

  const ALLOWED_TARGETS = Object.freeze({ "old_vehicle.affiliation": "报废车挂靠", "new_vehicle.affiliation": "新车挂靠" });
  const ALLOWED_VALUE_FIELDS = Object.freeze(new Set([
    "old_vehicle.recycle_date", "scrap_certificate.certificate_no", "old_vehicle.vin", "old_vehicle.plate_no", "old_vehicle.owner", "old_vehicle.engine_model",
    "invoice.code", "invoice.invoice_no", "invoice.amount", "invoice.invoice_date", "new_vehicle.vin", "new_vehicle.plate_no", "new_vehicle.owner",
    "page_ocr.new_vehicle_vin", "application.customer_name",
    "old_vehicle.type", "new_vehicle.fuel_type", "new_vehicle.registration_date",
    "application.terminal_phone", "application.terminal_certificate_no", "application.owner_type",
    "old_vehicle.affiliation", "new_vehicle.affiliation",
  ]));
  const OWNER_OPTIONS = Object.freeze({ PERSONAL: ["个人"], COMPANY: ["公司", "企业"] });
  // The production page currently renders Ant Design `a-form-item`, but the
  // same form is deployed in a few shells where the wrapper class is changed
  // (or removed by a micro-frontend).  Keep the framework selectors first and
  // use the data/class fallbacks only when resolving a labelled control.
  const ITEM_SELECTOR = ".ant-form-item, .el-form-item, .form-item, [data-form-item], [data-index][class*='form'], [class*='FormItem'], [class*='formItem']";
  const LABEL_SELECTOR = ".ant-form-item-label label, .el-form-item__label, label, [data-label], [data-field-label]";
  const COMBOBOX_SELECTOR = "[role='combobox'], input[aria-controls], input[aria-owns]";
  const RADIO_SELECTOR = "input[type='radio'], [role='radio']";
  // 兼容 Ant Design、Element 及无 role 的自定义列表；文本节点可能包在子节点内。
  const OPTION_SELECTOR = ".ant-select-item-option, .ant-select-dropdown-menu-item, .el-select-dropdown__item, [role='option'], li[data-value], li[data-label], [data-value], [data-label]";
  const normalize = (value: unknown) => String(value || "").replace(/[＊*]/g, "").replace(/\s+/g, "").replace(/[：:]$/, "");
  const normalizeAmount = (value: unknown) => {
    const raw = String(value ?? "").trim().replace(/[￥¥,，\s]/g, "");
    if (!raw) return "";
    const match = raw.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
    if (!match) return raw;
    const integer = (match[2] || "0").replace(/^0+(?=\d)/, "");
    const fraction = (match[3] || "").replace(/0+$/, "");
    const sign = match[1] === "-" && (integer !== "0" || fraction) ? "-" : "";
    return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
  };
  const normalizeFieldValue = (field: string, value: unknown) =>
    field === "invoice.amount" ? normalizeAmount(value) : normalize(value);
  // `innerText` is an empty string for virtualized/transitioning Ant options
  // even though `textContent` already contains the label.  Nullish fallback
  // is therefore insufficient; choose the first non-empty representation.
  const text = (element: DomElement | null | undefined) => [
    element?.innerText,
    element?.textContent,
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("data-label"),
    element?.getAttribute?.("title"),
    element?.value,
  ].map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const queryAll = (root: DomRoot | null | undefined, selector: string) => Array.from(root?.querySelectorAll?.<DomElement>(selector) || []);
  const connected = (element: DomElement | null | undefined) => element?.isConnected !== false;
  const hidden = (element: DomElement | null | undefined) => {
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
  const disabled = (element: DomElement | null | undefined) => {
    for (let node = element; node; node = node.parentElement) {
      if (node.disabled === true || node.getAttribute?.("aria-disabled") === "true") return true;
    }
    return false;
  };
  const writable = (element: DomElement | null | undefined, custom = false) => connected(element) && !hidden(element) && !disabled(element) && (custom || (element?.readOnly !== true && element?.getAttribute?.("readonly") == null));

  // 生产页的列表详情和审核弹窗可能同时保留两份表单。只在当前可见的
  // 详情弹窗内定位输入控件，避免后台列表/预览副本把目标判成“重复”。
  // 下拉选项仍从 document 根节点扫描，因为 Ant Design 会把 dropdown
  // portal 挂到 body，而不是挂在表单弹窗内。
  const activeFormRoot = (root: DomRoot) => {
    const candidates = queryAll(root, ".my-page-modal, .ant-modal, .ant-drawer, [role='dialog']")
      .filter((item) => !hidden(item))
      .filter((item) => item.querySelector?.<DomElement>(".largeForm, .ant-form, .el-form, form"));
    const current = candidates.at(-1);
    const selected = current?.querySelector?.<DomElement>(".largeForm, .ant-form, .el-form, form") || current;
    if (selected) return selected;
    // The production drawer sometimes has no dialog class at all. Prefer the
    // last visible largeForm before falling back to document root.
    const forms = queryAll(root, ".largeForm, .ant-form, .el-form, form").filter((item) => !hidden(item));
    return forms.at(-1) || root;
  };

  const nearestFieldItem = (element: DomElement | null | undefined) => {
    if (!element) return null;
    if (typeof element.closest === "function") {
      const item = element.closest(ITEM_SELECTOR);
      if (item) return item;
    }
    // Last-resort fallback for a wrapper without a framework class.  Stop at
    // the first ancestor that owns the label and exactly one logical control;
    // never return the document/body, which would make both repeated fields
    // appear as one ambiguous item.
    for (let node = element.parentElement; node && node.parentElement; node = node.parentElement) {
      const labels = queryAll(node, LABEL_SELECTOR);
      const controls = queryAll(node, `select, ${COMBOBOX_SELECTOR}`);
      if (labels.length === 1 && controls.length === 1) return node;
      if (node.tagName === "FORM" || node.tagName === "FIELDSET") break;
    }
    return null;
  };

  function fieldItems(root: DomRoot, label: string) {
    const expected = normalize(label);
    const items = queryAll(root, ITEM_SELECTOR).filter((item) => {
      const actual = normalize(text(item.querySelector?.<DomElement>(LABEL_SELECTOR)));
      return actual === expected || actual.startsWith(expected);
    });
    if (items.length) return [...new Set(items)];

    // Framework-free/custom form fallback.  Resolve labels first and map each
    // one to its nearest field item, rather than treating the whole form as a
    // single target.
    const fallback = queryAll(root, `${LABEL_SELECTOR}, [aria-label], [data-label]`)
      .filter((node) => {
        const actual = normalize(text(node));
        return actual === expected || actual.startsWith(expected);
      })
      .map(nearestFieldItem)
      .filter((item): item is DomElement => item !== null);
    return [...new Set(fallback)];
  }

  const visibleFieldItems = (root: DomRoot, label: string) => fieldItems(root, label).filter((item) => !hidden(item));

  function customTrigger(control: DomElement) {
    // Ant Design handles opening on the selector's mousedown. Clicking the
    // nested search input is not reliable across versions.
    return control?.closest?.<DomElement>(".ant-select")?.querySelector?.<DomElement>(".ant-select-selector")
      || control?.closest?.<DomElement>(".el-select")?.querySelector?.<DomElement>(".el-input__wrapper, .el-input")
      || control;
  }

  const radioInputs = (item: DomElement) => queryAll(item, RADIO_SELECTOR)
    .filter((control) => connected(control) && !hidden(control) && !disabled(control));

  const radioLabel = (control: DomElement) => {
    const wrapper = control?.closest?.<DomElement>("label, [role='radio'], .ant-radio-wrapper, .el-radio") || control?.parentElement;
    if (!wrapper) return text(control);
    // Ant Design puts the actual choice text in the label after the input;
    // remove the input's value so a value such as `1` cannot be mistaken for
    // the visible label.
    const value = normalize(control?.value);
    const raw = text(wrapper);
    const normalized = normalize(raw);
    if (value && normalized === value) return raw;
    return raw;
  };

  const radioChecked = (control: DomElement) => Boolean(
    control?.checked === true
      || control?.getAttribute?.("aria-checked") === "true"
      || control?.closest?.<DomElement>("label, [role='radio'], .ant-radio-wrapper, .el-radio")?.getAttribute?.("aria-checked") === "true",
  );

  const radioOption = (control: DomElement) => ({
    control,
    label: radioLabel(control),
    value: String(control?.value ?? radioLabel(control)),
  });

  const radioOptions = (resolved: ResolvedControl, ownerType: PageFillAction["owner_type"]) => {
    const aliases = OWNER_OPTIONS[ownerType] || [];
    return (resolved.radioInputs ?? [])
      .map(radioOption)
      .filter((option) => aliases.includes(normalize(option.label)) && writable(option.control, true));
  };

  function toggleCustomControl(resolved: PopupControl) {
    const trigger = resolved.trigger || resolved.control;
    // Ant Design opens on mousedown in some versions, while Element opens on
    // click. Dispatch both when available; the native click remains the
    // fallback used by the lightweight test fixture.
    const EventClass = trigger?.ownerDocument?.defaultView?.MouseEvent || globalThis.MouseEvent;
    const eventInit = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: trigger?.ownerDocument?.defaultView || null };
    trigger?.dispatchEvent?.(new EventClass("mousedown", eventInit));
    trigger?.click?.();
  }

  const controlExpanded = (resolved: PopupControl) => {
    const control = resolved?.control;
    const trigger = resolved?.trigger;
    return [control, trigger]
      .map((element) => element?.getAttribute?.("aria-expanded"))
      .some((value) => value === "true");
  };

  function triggerInvoiceVerification(root: DomRoot) {
    // Preview/hidden forms can contain a second copy of the same label. Only
    // visible form items are eligible for the real audit action.
    const formRoot = activeFormRoot(root);
    const items = visibleFieldItems(formRoot, "发票号码");
    if (items.length > 1) return { ok: false, message: "发票号码存在重复控件，无法执行验真" };
    const item = items[0];
    const candidates = item
      ? queryAll(item, "button, input[type='button'], input[type='submit'], [role='button'], a")
      : [];
    const isVerifyButton = (candidate: DomElement) => /一键验真/.test(`${text(candidate)} ${candidate.value || ""}`)
      && writable(candidate, true);
    const button = candidates.find(isVerifyButton)
      || queryAll(formRoot, "button, input[type='button'], input[type='submit'], [role='button'], a").find(isVerifyButton)
      || queryAll(root, "button, input[type='button'], input[type='submit'], [role='button'], a").filter((candidate) => !hidden(candidate)).find(isVerifyButton);
    if (!button) return { ok: false, message: "未找到发票号码旁的一键验真按钮" };
    button.click?.();
    return { ok: true, message: "已点击一键验真" };
  }

  function resolveControl(root: DomRoot, action: PageFillAction): Resolution {
    // The list page and the approval drawer can keep a hidden copy of the
    // same form in the DOM. Only the visible detail form is eligible for a
    // write; hidden copies must not make the target look duplicated.
    const formRoot = activeFormRoot(root);
    const items = fieldItems(formRoot, action.target_label).filter((item) => !hidden(item));
    if (items.length !== 1) return { error: items.length ? `${action.target_label}存在重复控件，已停止填写` : `未找到${action.target_label}控件` };
    const item = items[0];
    if (!writable(item, true)) return { error: `${action.target_label}控件不可写或已变化，页面已刷新` };
    const nativeControls = queryAll(item, "select");
    const combos = queryAll(item, COMBOBOX_SELECTOR);
    const radios = radioInputs(item);
    // A radio group intentionally contains multiple input elements.  Treat
    // that group as one logical control; multiple independent groups remain
    // unsafe and are rejected below.
    if (!nativeControls.length && !combos.length && radios.length) {
      const radioGroups = new Set(radios.map((radio) => radio.closest?.<DomElement>("[role='radiogroup'], .ant-radio-group, .el-radio-group, fieldset") || item));
      if (radioGroups.size !== 1) return { error: `${action.target_label}存在多个逻辑控件，已停止填写` };
      return { item, control: radios[0], radioInputs: radios, radioGroup: [...radioGroups][0] };
    }
    if (nativeControls.length + combos.length > 1 || radios.length) return { error: `${action.target_label}存在多个逻辑控件，已停止填写` };
    if (nativeControls.length === 1) {
      const nativeSelect = nativeControls[0];
      if (!writable(nativeSelect)) return { error: `${action.target_label}控件不可写或已变化，页面已刷新` };
      return { item, control: nativeSelect, nativeSelect };
    }
    if (combos.length !== 1) return { error: combos.length ? `${action.target_label}存在多个逻辑控件，已停止填写` : `未找到${action.target_label}可写控件` };
    const control = combos[0];
    if (!writable(control, true)) return { error: `${action.target_label}控件不可写或已变化，页面已刷新` };
    const listboxId = control.getAttribute?.("aria-controls") || control.getAttribute?.("aria-owns") || "";
    return { item, control, trigger: customTrigger(control), listboxId };
  }

  function nativeCurrent(select: DomElement) {
    const value = String(select.value ?? "");
    if (!value) return { value: "", label: "" };
    const selected = Array.from(select.options || []).find((option) => String(option.value ?? text(option)) === value);
    return { value, label: text(selected) || value };
  }

  function currentValue(resolved: ResolvedControl) {
    if (resolved.nativeSelect) return nativeCurrent(resolved.nativeSelect).label;
    if (resolved.radioInputs) {
      const selected = resolved.radioInputs.find(radioChecked);
      return selected ? radioLabel(selected) : "";
    }
    return String(resolved.control?.value ?? "").trim() || text(resolved.item.querySelector?.<DomElement>(".ant-select-selection-item, .el-select__selected-item, .el-input__inner"));
  }

  function matchingOptions(options: DomElement[], ownerType: PageFillAction["owner_type"]) {
    const aliases = OWNER_OPTIONS[ownerType] || [];
    const matches = [];
    const seen = new Set();
    for (const item of options) {
      const candidate = item.closest?.<DomElement>(OPTION_SELECTOR) || item;
      const label = candidate?.getAttribute?.("data-label") || candidate?.getAttribute?.("aria-label") || candidate?.innerText || candidate?.textContent || text(candidate);
      if (candidate && writable(candidate) && aliases.includes(normalize(label ?? "")) && !seen.has(candidate)) {
        seen.add(candidate);
        matches.push(candidate);
      }
    }
    return matches;
  }

  function nativeOptions(resolved: ResolvedControl, ownerType: PageFillAction["owner_type"]) { return matchingOptions(Array.from(resolved.nativeSelect?.options || []), ownerType); }
  const settle = () => globalThis.setTimeout
    ? new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50))
    : Promise.resolve();

  const guardError = "页面已变化，请重新审核";
  const sameCollectedRecord = (guard: Guard) => typeof guard !== "function" || guard();

  async function customOptions(root: DomRoot, resolved: ResolvedControl, ownerType: PageFillAction["owner_type"], closeAfter: boolean, guard: Guard) {
    if (!sameCollectedRecord(guard)) return { error: guardError };
    const visibleContainers = () => queryAll(root, "[role='listbox'], .ant-select-dropdown, .ant-select-dropdown-menu, .el-select-dropdown, ul").filter((item) => connected(item) && !hidden(item));
    const optionNodes = (container: DomElement) => queryAll(container, OPTION_SELECTOR + ", li, [class*='option'], [class*='Option'], [data-label], [data-value]");
    let listbox = resolved.listboxId ? root?.getElementById?.(resolved.listboxId) : null;
    const alreadyOpen = controlExpanded(resolved);
    if (!alreadyOpen) toggleCustomControl(resolved);
    let matches: DomElement[] = [];
    // Vue nextTick、Ant popup 动画和字典异步加载可能连续跨多个 task；
    // 仅等待一个 16ms 帧会造成“选项不存在”的假阴性。
    for (let attempt = 0; attempt < 8 && matches.length === 0; attempt += 1) {
      await settle();
      if (!sameCollectedRecord(guard)) return { error: guardError };
      listbox = resolved.listboxId ? root?.getElementById?.(resolved.listboxId) : null;
      // A portal can leave an empty/stale aria-controls target in the DOM.
      // Scan that target and visible dropdowns, deduplicating option elements.
      const containers = [
        ...(listbox && connected(listbox) && !hidden(listbox) ? [listbox] : []),
        ...visibleContainers(),
      ].filter((container, index, all) => all.indexOf(container) === index);
      matches = containers.flatMap((container) => matchingOptions(
        container === listbox ? queryAll(listbox, OPTION_SELECTOR) : optionNodes(container),
        ownerType,
      ));
      matches = [...new Set(matches)];
    }
    if (closeAfter && !alreadyOpen) {
      toggleCustomControl(resolved);
      await settle();
      if (!sameCollectedRecord(guard)) return { error: guardError };
    }
    return { options: matches };
  }

  function validateActions(actions: PageFillAction[]) {
    if (!Array.isArray(actions) || actions.length !== 2) return "挂靠填写意图不完整，已停止填写";
    const fields = new Set();
    for (const action of actions) {
      if (!action || ALLOWED_TARGETS[action.field] !== action.target_label || !OWNER_OPTIONS[action.owner_type] || fields.has(action.field)) return "检测到不允许自动填写的页面字段";
      fields.add(action.field);
    }
    return fields.size === Object.keys(ALLOWED_TARGETS).length ? null : "挂靠填写意图不完整，已停止填写";
  }

  function validatePendingState(root: DomRoot, actions: PageFillAction[], expected: Map<string, ResolvedControl> = new Map(), guard: Guard) {
    if (!sameCollectedRecord(guard)) return { error: guardError };
    for (const action of actions) {
      const resolved = resolveControl(root, action);
      if ("error" in resolved && resolved.error !== undefined) return { error: resolved.error };
      const original = expected.get(action.field);
      if (original && (original.item !== resolved.item || original.control !== resolved.control)) return { error: `${action.target_label}控件已变化，页面已刷新` };
      if (currentValue(resolved)) return { error: `${action.target_label}已有值，禁止覆盖` };
    }
    return {};
  }

  async function validatePending(root: DomRoot, actions: PageFillAction[], expected: Map<string, ResolvedControl> = new Map(), guard: Guard): Promise<Preparation> {
    const currentState = validatePendingState(root, actions, expected, guard);
    if (currentState.error) return currentState;
    const prepared = [];
    for (const action of actions) {
      const resolved = resolveControl(root, action);
      if (resolved.error !== undefined) return { error: resolved.error };
      const result = resolved.radioInputs
        ? { options: radioOptions(resolved, action.owner_type) }
        : resolved.nativeSelect
        ? { options: nativeOptions(resolved, action.owner_type) }
        : await customOptions(root, resolved, action.owner_type, true, guard);
      if ("error" in result) return { error: result.error || "选项解析失败" };
      const options = result.options;
      if (options.length !== 1) return { error: `${action.target_label}的个人/公司选项${options.length ? "存在歧义" : "不存在"}` };
      prepared.push({ action, resolved });
    }
    return { prepared };
  }

  async function preflight(root: DomRoot, actions: PageFillAction[], guard: Guard) {
    const validationError = validateActions(actions);
    return validationError ? { error: validationError } : validatePending(root, actions, new Map(), guard);
  }

  function dispatchNative(select: DomElement, root: DomRoot) {
    const EventClass = root?.defaultView?.Event || globalThis.Event;
    if (!EventClass) return;
    select.dispatchEvent?.(new EventClass("input", { bubbles: true }));
    select.dispatchEvent?.(new EventClass("change", { bubbles: true }));
  }

  async function fillOne(root: DomRoot, action: PageFillAction, expected: ResolvedControl | undefined, pendingActions: PageFillAction[], expectedControls: Map<string, ResolvedControl>, guard: Guard) {
    if (!sameCollectedRecord(guard)) return { error: guardError };
    const resolved = resolveControl(root, action);
    if (resolved.error !== undefined || !expected || expected.item !== resolved.item || expected.control !== resolved.control || currentValue(resolved)) return { error: resolved.error || `${action.target_label}控件已变化或已有值，禁止覆盖` };
    if (resolved.radioInputs) {
      const options = radioOptions(resolved, action.owner_type);
      if (options.length !== 1) return { error: `${action.target_label}选项已变化` };
      const pendingState = validatePendingState(root, pendingActions, expectedControls, guard);
      if (pendingState.error) return pendingState;
      const choice = options[0].control;
      if (!writable(choice, true)) return { error: `${action.target_label}选项不可写` };
      choice.click?.();
      dispatchNative(choice, root);
    } else if (resolved.nativeSelect) {
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
      if (optionResult.error !== undefined) return optionResult;
      const pendingState = validatePendingState(root, pendingActions, expectedControls, guard);
      if (pendingState.error) return pendingState;
      const options = optionResult.options;
      const fresh = resolveControl(root, action);
      if (fresh.error !== undefined || fresh.item !== expected.item || fresh.control !== expected.control || currentValue(fresh) || options.length !== 1 || !writable(options[0])) return { error: `${action.target_label}选项或控件已变化，禁止覆盖` };
      if (!sameCollectedRecord(guard)) return { error: guardError };
      options[0].click?.();
      await settle();
      if (!sameCollectedRecord(guard)) return { error: guardError, wrote: true };
    }
    const refreshed = resolveControl(root, action);
    if (refreshed.error !== undefined) return { error: `${action.target_label}控件已变化，页面已刷新`, wrote: true };
    if (!OWNER_OPTIONS[action.owner_type].includes(normalize(currentValue(refreshed)))) return { error: `${action.target_label}写入后回读失败`, wrote: true };
    return { status: "FILLED", field: action.field, label: action.target_label, value: normalize(currentValue(refreshed)) };
  }

  // 回滚只恢复本次调用写入过的两个挂靠字段的原值；同样走受控写入路径并遵守字段白名单。
  const CLEAR_SELECTOR = ".ant-select-clear, .ant-select-clear-icon, .el-select__clear, .el-input__clear";

  function snapshotValue(resolved: ResolvedControl): OriginalValue {
    if (resolved.nativeSelect) {
      return {
        label: nativeCurrent(resolved.nativeSelect).label,
        raw: String(resolved.nativeSelect.value ?? ""),
        selectedOptions: Array.from(resolved.nativeSelect.options || []).filter((option) => option.selected === true),
      };
    }
    if (resolved.radioInputs) {
      const selected = resolved.radioInputs.find(radioChecked);
      return {
        label: selected ? radioLabel(selected) : "",
        selectedRadio: selected,
      };
    }
    return { label: currentValue(resolved) };
  }

  async function restoreCustomOption(root: DomRoot, resolved: PopupControl, targetLabel: string, label: string, guard: Guard) {
    toggleCustomControl(resolved);
    let target = null;
    for (let attempt = 0; attempt < 3 && !target; attempt += 1) {
      await settle();
      if (!sameCollectedRecord(guard)) return guardError;
      const listbox = root?.getElementById?.(resolved.listboxId || "");
      const containers = [
        ...(listbox && connected(listbox) && !hidden(listbox) ? [listbox] : []),
        ...queryAll(root, "[role='listbox'], .ant-select-dropdown, .ant-select-dropdown-menu, .el-select-dropdown, ul").filter((item) => connected(item) && !hidden(item)),
      ].filter((container, index, all) => all.indexOf(container) === index);
      target = containers.flatMap((container) => queryAll(container, OPTION_SELECTOR + ", li, [class*='option'], [class*='Option'], [data-label], [data-value]"))
        .map((item) => item.closest?.<DomElement>(OPTION_SELECTOR) || item)
        .find((item) => writable(item) && normalize(text(item)) === normalize(label ?? "")) || null;
    }
    if (!target) {
      toggleCustomControl(resolved);
      await settle();
      return `${targetLabel}无法恢复原值，回滚失败`;
    }
    target.click?.();
    return null;
  }

  async function restoreControl(root: DomRoot, entry: RollbackEntry, guard: Guard) {
    const { action, resolved, original } = entry;
    if (!ALLOWED_TARGETS[action.field]) return `${action.field}不在允许写入的字段内`;
    if (!sameCollectedRecord(guard)) return guardError;
    const fresh = resolveControl(root, action);
    if (fresh.error !== undefined || fresh.item !== resolved.item || fresh.control !== resolved.control) return `${action.target_label}控件已变化，回滚失败`;
    if (normalize(currentValue(fresh)) !== normalize(original.label)) {
      if (fresh.radioInputs) {
        for (const radio of fresh.radioInputs) {
          if (radio === original.selectedRadio) radio.click?.();
        }
        if (original.selectedRadio) dispatchNative(original.selectedRadio, root);
      } else if (fresh.nativeSelect) {
        fresh.nativeSelect.value = original.raw ?? "";
        for (const option of Array.from(fresh.nativeSelect.options || [])) option.selected = (original.selectedOptions ?? []).includes(option);
        dispatchNative(fresh.nativeSelect, root);
      } else if (!original.label) {
        const clear = fresh.item.querySelector?.<DomElement>(CLEAR_SELECTOR);
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
    if (after.error !== undefined || normalize(currentValue(after)) !== normalize(original.label)) return `${action.target_label}回滚后回读失败`;
    return null;
  }

  async function execute(root: DomRoot, actions: PageFillAction[], guard: Guard) {
    const checked = await preflight(root, actions, guard);
    if (checked.error !== undefined) return { ok: false, message: checked.error, actions: [] };
    const originals = new Map(checked.prepared.map((item) => [item.action.field, item.resolved]));
    const snapshot = new Map(checked.prepared.map((item) => [item.action.field, { action: item.action, resolved: item.resolved, original: snapshotValue(item.resolved) }]));
    const written: Array<"old_vehicle.affiliation" | "new_vehicle.affiliation"> = []
    const results = [];
    // 全有或全无：任一写入或回读失败时回滚本次调用已写入的字段；身份失效则立即停止一切写入。
    const fail = async (message: string) => {
      if (!written.length) return { ok: false, message, actions: [] };
      if (!sameCollectedRecord(guard)) return { ok: false, message: `${message}；页面身份已失效，已停止回滚写入`, actions: [] };
      const errors = [];
      for (const field of [...written].reverse()) {
        const entry = snapshot.get(field);
        const error = entry ? await restoreControl(root, entry, guard) : "回滚快照缺失";
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
        if ("wrote" in result && result.wrote) written.push(action.field);
        return await fail(result.error);
      }
      written.push(action.field);
      results.push(result);
    }
    return { ok: true, message: "挂靠字段已填写并回读", actions: results };
  }

  function writableValueControl(entry: DomElement | null | undefined) {
    if (!entry) return null;
    if (entry.getAttribute?.("role") === "combobox") return entry;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(entry.tagName)) return entry;
    const candidates = queryAll(entry, "[role='combobox'], input, textarea, select")
      .filter((control) => connected(control) && !hidden(control) && control.getAttribute?.("type") !== "hidden");
    return candidates.length === 1 ? candidates[0] : null;
  }

  function dispatchValue(control: DomElement, value: string, root: DomRoot) {
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

  function readValueControl(control: DomElement) {
    if (control.tagName === "SELECT") return nativeCurrent(control).label;
    if (control.getAttribute?.("role") === "combobox") {
      const container = control.closest?.<DomElement>(".ant-select, .el-select") || control.parentElement;
      const selected = container?.querySelector?.<DomElement>(".ant-select-selection-item, .el-select__selected-item");
      if (selected) return text(selected);
    }
    return String(control.value ?? text(control)).trim();
  }

  function captureValue(entry: DomElement | null | undefined) {
    const control = writableValueControl(entry);
    return control ? { control, value: readValueControl(control) } : null;
  }

  async function executeValue(root: DomRoot, entry: DomElement | null | undefined, action: PageWriteAction, guard: Guard) {
    if (!action || !ALLOWED_VALUE_FIELDS.has(action.field)) return { ok: false, message: "该字段不在报废置换允许回填范围内" };
    if (!entry || !sameCollectedRecord(guard)) return { ok: false, message: guardError };
    const control = writableValueControl(entry);
    const custom = control?.getAttribute?.("role") === "combobox";
    if (!control || !writable(control, custom)) return { ok: false, message: "目标字段不可写或页面已变化" };
    if (!String(action.value ?? "").trim()) return { ok: false, message: "回填值不能为空" };
    const original = readValueControl(control);
    const originalRaw = control.tagName === "SELECT" ? String(control.value ?? "") : original;
    if (action.expectedValue != null && normalizeFieldValue(action.field, original) !== normalizeFieldValue(action.field, action.expectedValue)) {
      return { ok: false, code: "FIELD_VALUE_CHANGED", currentValue: original,
        message: "该字段当前值与采集时不同，已更新页面值，请核对后再次回填" };
    }
    const resolved = {
      control, trigger: customTrigger(control),
      listboxId: control.getAttribute?.("aria-controls") || control.getAttribute?.("aria-owns"),
    };
    const error = custom
      ? await restoreCustomOption(root, resolved, action.field, action.value, guard)
      : dispatchValue(control, action.value, root);
    if (error) return { ok: false, message: error };
    await settle();
    if (!sameCollectedRecord(guard) || !connected(control)) return { ok: false, message: guardError };
    const after = readValueControl(control);
    if (normalizeFieldValue(action.field, after) !== normalizeFieldValue(action.field, action.value)) {
      if (sameCollectedRecord(guard)) {
        if (custom) {
          const restoreError = await restoreCustomOption(root, resolved, action.field, original, guard);
          if (restoreError) return { ok: false, message: `回填后回读失败；${restoreError}` };
        } else if (control.tagName === "SELECT") {
          control.value = originalRaw;
          dispatchNative(control, root);
        } else {
          dispatchValue(control, original, root);
        }
      }
      return { ok: false, message: "回填后回读失败" };
    }
    try { control.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" }); } catch { control.scrollIntoView?.(); }
    control.focus?.({ preventScroll: true });
    const highlightTarget = control.closest?.<DomElement>(".ant-input-affix-wrapper, .ant-select, .ant-picker, .el-input, .el-select, .el-date-editor") || control;
    highlightTarget.animate?.([
      { outline: "3px solid #1677ff", outlineOffset: "3px", backgroundColor: "#e6f4ff" },
      { outline: "3px solid #1677ff", outlineOffset: "3px", backgroundColor: "#e6f4ff", offset: 0.85 },
      { outline: "3px solid transparent", outlineOffset: "3px" },
    ], { duration: 4000 });
    return { ok: true, message: "字段已回填并回读，已定位到页面字段", actions: [{ field: action.field, label: action.field, value: after, status: "FILLED" }] };
  }

  async function executeValueGroup(
    root: DomRoot,
    entries: Array<{ field: string; element: DomElement; expectedValue?: string | null }>,
    action: PageWriteGroupAction,
    guard: Guard,
  ) {
    if (!action.fields.length || action.fields.length !== entries.length || !String(action.value || "").trim()) {
      return { ok: false, message: "组合字段回填参数不完整", actions: [] };
    }
    const prepared: Array<GroupPrepared | GroupPreparationFailure> = entries.map((entry) => {
      if (!ALLOWED_VALUE_FIELDS.has(entry.field)) return { error: `${entry.field}不在报废置换允许回填范围内` };
      const control = writableValueControl(entry.element);
      const custom = control?.getAttribute?.("role") === "combobox";
      if (!control || !writable(control, custom)) return { error: `${entry.field}目标控件不可写` };
      const current = readValueControl(control);
      const expected = entry.expectedValue ?? action.expectedValues[entry.field];
      if (expected != null && normalizeFieldValue(entry.field, current) !== normalizeFieldValue(entry.field, expected)) {
        return { error: `${entry.field}当前值已变化，请重新采集后回填`, code: "FIELD_VALUE_CHANGED", currentValue: current };
      }
      return {
        field: entry.field,
        control,
        custom,
        original: current,
        resolved: { control, trigger: customTrigger(control), listboxId: control.getAttribute?.("aria-controls") || control.getAttribute?.("aria-owns") },
      };
    });
    const failed = prepared.find((item): item is GroupPreparationFailure => "error" in item);
    if (failed) return { ok: false, message: failed.error, code: failed.code, currentValue: failed.currentValue, actions: [] };
    const successful = prepared.filter((item): item is GroupPrepared => "control" in item);
    const written: GroupPrepared[] = [];
    const rollback = async (message: string) => {
      const errors: string[] = [];
      if (!sameCollectedRecord(guard)) return { ok: false, message: `${message}；页面身份已失效，已停止回滚写入`, actions: [] };
      for (const item of [...written].reverse()) {
        const restoreError = item.custom
          ? await restoreCustomOption(root, item.resolved, item.field, item.original, guard)
          : dispatchValue(item.control, item.original, root);
        if (restoreError) errors.push(String(restoreError));
      }
      await settle();
      return errors.length
        ? { ok: false, message: `${message}；自动回滚未完成（${errors.join("；")}），请人工核对页面`, actions: [] }
        : { ok: false, message: `${message}；已回滚`, actions: [] };
    };
    for (const item of successful) {
      if (!sameCollectedRecord(guard)) return await rollback("页面身份已失效，已停止组合回填");
      const error = item.custom
        ? await restoreCustomOption(root, item.resolved, item.field, action.value, guard)
        : dispatchValue(item.control, action.value, root);
      if (error) return await rollback(String(error));
      written.push(item);
      await settle();
    }
    if (!sameCollectedRecord(guard)) return await rollback("页面身份已失效，已停止组合回填");
    const results = [];
    for (const item of successful) {
      const after = readValueControl(item.control);
      if (normalizeFieldValue(item.field, after) !== normalizeFieldValue(item.field, action.value)) return await rollback(`${item.field}回填后回读失败`);
      results.push({ field: item.field, label: item.field, value: after, status: "FILLED" });
      const target = item.control.closest?.<DomElement>(".ant-input-affix-wrapper, .ant-select, .ant-picker, .el-input, .el-select, .el-date-editor") || item.control;
      target.animate?.([
        { outline: "3px solid #1677ff", outlineOffset: "3px", backgroundColor: "#e6f4ff" },
        { outline: "3px solid transparent", outlineOffset: "3px" },
      ], { duration: 4000 });
    }
    return { ok: true, message: "组合字段已同时回填并回读", actions: results };
  }

  export const ReviewPageFieldWriter = { execute, preflight, executeValue, executeValueGroup, captureValue, triggerInvoiceVerification };
