/**
 * 功能：从表单、表格和只读 DOM 提取标准字段候选。
 * 职责边界：同等可靠候选冲突时保留歧义，不猜测值；只有唯一候选才保留 DOM 目标。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

(() => {
  const FIELD_DEFINITIONS = {
    "application.id": {
      aliases: ["申请单ID", "申请单编号"],
      section: "unknown",
    },
    "application.submitted_at": {
      aliases: ["申请时间"],
      section: "unknown",
      reviewable: false,
    },
    "application.owner_type": {
      aliases: ["车辆所有人类型"],
      section: "unknown",
    },
    "page_ocr.new_vehicle_vin": {
      aliases: ["OCR新车车架号"],
      section: "unknown",
    },
    "application.customer_name": {
      aliases: ["客户名称"],
      section: "unknown",
    },
    "old_vehicle.type": {
      aliases: ["报废车辆类型"],
      section: "old_vehicle",
    },
    "application.dealer_name": {
      aliases: ["经销商"],
      section: "old_vehicle",
      // 经销商由系统写死展示，不是审核详情中的可编辑/可核验控件。
      reviewable: false,
    },
    "old_vehicle.recycle_date": {
      aliases: ["报废交车日期", "报废车日期"],
      section: "old_vehicle",
    },
    "old_vehicle.vin": {
      aliases: ["报废车辆车架号", "旧车车架号", "车架号"],
      section: "old_vehicle",
      sectionRequired: true,
    },
    "old_vehicle.owner": {
      aliases: ["报废车辆所有人", "旧车所有人", "车辆所有人", "所有人"],
      section: "old_vehicle",
      sectionRequired: true,
    },
    "old_vehicle.plate_no": {
      aliases: ["报废车辆车牌号", "旧车车牌号", "车牌号"],
      section: "old_vehicle",
      sectionRequired: true,
    },
    "old_vehicle.engine_model": {
      aliases: ["报废发动机型号", "发动机型号"],
      section: "old_vehicle",
    },
    "scrap_certificate.certificate_no": {
      aliases: ["报废证明编号", "回收证明编号"],
      section: "old_vehicle",
    },
    "new_vehicle.vin": {
      aliases: ["新车车架号", "车架号"],
      section: "new_vehicle",
      sectionRequired: true,
    },
    "new_vehicle.owner": {
      aliases: ["新车所有人", "车辆所有人", "所有人"],
      section: "new_vehicle",
      sectionRequired: true,
    },
    "new_vehicle.plate_no": {
      aliases: ["新车车牌号", "车牌号"],
      section: "new_vehicle",
      sectionRequired: true,
    },
    "invoice.code": {
      aliases: ["发票代码"],
      section: "new_vehicle",
    },
    "invoice.invoice_no": {
      aliases: ["发票号码"],
      section: "new_vehicle",
    },
    "invoice.invoice_date": {
      aliases: ["开票日期", "发票日期"],
      section: "new_vehicle",
    },
    "invoice.amount": {
      aliases: ["开票金额"],
      section: "new_vehicle",
    },
    "new_vehicle.fuel_type": {
      aliases: ["新车燃料类型"],
      section: "new_vehicle",
    },
    "new_vehicle.registration_date": {
      aliases: ["注册日期"],
      section: "new_vehicle",
    },
    "application.terminal_certificate_no": {
      aliases: ["终端证件号"],
      section: "new_vehicle",
    },
    "application.terminal_phone": {
      aliases: ["终端客户手机号"],
      section: "new_vehicle",
    },
    "transfer.plate_no": {
      aliases: ["车牌号"],
      section: "transfer",
      sectionRequired: true,
    },
    "transfer.vin": {
      aliases: ["识别车架号", "车架号"],
      section: "transfer",
      sectionRequired: true,
    },
    "transfer.buyer_name": {
      aliases: ["过户发票买家名称", "买方名称"],
      section: "transfer",
      sectionRequired: true,
    },
    "transfer.seller_name": {
      aliases: ["卖方名称"],
      section: "transfer",
      sectionRequired: true,
    },
    "transfer.invoice_date": {
      aliases: ["开票日期"],
      section: "transfer",
      sectionRequired: true,
    },
    "transfer.source_publish_date": {
      aliases: ["车源发布时间", "车源发布日期"],
      section: "transfer",
      sectionRequired: true,
    },
  };

  const SOURCE_SCORES = {
    control: 400,
    table: 350,
    structured: 300,
    inline: 200,
    adjacent: 100,
  };
  // Ant Design's a-select exposes an input role=combobox; some deployed
  // shells put the role on the trigger itself. Include both forms so the
  // affiliation controls are never omitted from the inventory.
  const CONTROL_SELECTOR = "input, textarea, select, [role='combobox'], input[aria-controls], input[aria-owns], [contenteditable]:not([contenteditable='false'])";
  const FORM_ITEM_SELECTOR = ".ant-form-item, .el-form-item, .form-item, [data-form-item], [data-index][class*='form'], [class*='FormItem'], [class*='formItem']";
  const WRITABLE_TARGETS = {
    "报废车挂靠": "old_vehicle.affiliation",
    "新车挂靠": "new_vehicle.affiliation",
  };
  const SYSTEM_CONTROL_LABELS = new Set(["审核状态", "审核进度", "审核结果"]);

  const normalizeText = (value) => String(value || "")
    .replace(/[＊*]/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:]$/, "");
  const PLACEHOLDER_VALUES = new Set(["审核进度", "待审核", "审核中", "处理中", "未审核", "请选择", "请输入"]);
  const isUsableValue = (value) => {
    const normalized = normalizeText(value);
    return Boolean(normalized) && !PLACEHOLDER_VALUES.has(normalized);
  };
  const isDataControl = (control) => {
    const type = String(control?.getAttribute?.("type") || "text").toLowerCase();
    return !["hidden", "button", "submit", "reset", "image"].includes(type);
  };
  const isVerificationCandidate = (candidate) => {
    const label = normalizeText(candidate?.label);
    const value = normalizeText(candidate?.value);
    return /验真/.test(label) || (/(发票号码|发票代码)/.test(label) && /^(?:一键)?验真$/.test(value));
  };
  const visibleText = (element) => String(element?.innerText ?? element?.textContent ?? "").trim();

  const directText = (element) => {
    const fixtureText = element?.getAttribute?.("data-direct-text");
    if (fixtureText) return fixtureText.trim();
    if (!element?.childNodes) return visibleText(element);
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || "")
      .join(" ")
      .trim();
  };

  const sectionFromText = (text) => {
    const value = String(text || "");
    const hasTransfer = /审核过户凭证|过户资料|过户发票/.test(value);
    const hasOld = /报废车辆信息|报废车辆资料|报废车资料|旧车资料/.test(value);
    const hasNew = /新车及发票信息|新车及发票资料|新车资料|发票信息/.test(value);
    if (hasTransfer) return "transfer";
    if (hasOld && !hasNew) return "old_vehicle";
    if (hasNew && !hasOld) return "new_vehicle";
    return "unknown";
  };

  const definitionForLabel = (label) => {
    const normalized = normalizeText(label);
    const matches = Object.entries(FIELD_DEFINITIONS).filter(([, definition]) =>
      definition.aliases.some((alias) => normalizeText(alias) === normalized),
    );
    if (matches.length !== 1) return null;
    const [field, definition] = matches[0];
    return { field, ...definition };
  };

  const isKnownLabel = (label) => {
    const normalized = normalizeText(label);
    return Object.values(FIELD_DEFINITIONS).some((definition) =>
      definition.aliases.some((alias) => normalizeText(alias) === normalized),
    );
  };

  const writableTargetField = (label) => {
    const normalized = normalizeText(label);
    const match = Object.entries(WRITABLE_TARGETS).find(([targetLabel]) =>
      normalized === targetLabel || normalized.startsWith(targetLabel),
    );
    return match?.[1] || null;
  };

  const isSearchFilterControl = (control) => Boolean(
    control?.closest?.(".smallForm, .formInline, [class*='formInline']"),
  );

  const isSystemControlLabel = (label) => {
    const normalized = normalizeText(label);
    return [...SYSTEM_CONTROL_LABELS].some((systemLabel) =>
      normalized === systemLabel || normalized.startsWith(systemLabel),
    );
  };

  const isSectionRequired = (field) => Boolean(FIELD_DEFINITIONS[field]?.sectionRequired);

  const queryAll = (root, selector) => {
    try {
      return Array.from(root?.querySelectorAll?.(selector) || []);
    } catch {
      return [];
    }
  };

  const readControlValue = (control) => {
    if (control?.tagName === "SELECT") {
      return String(control.selectedOptions?.[0]?.textContent || control.value || "").trim();
    }
    // Ant Design/Element 的 combobox value 可能是字典 code（例如
    // ENTERPRISE/NATURAL_GAS），页面上真正展示的是 option label。优先读取
    // 当前可见 label，避免把内部 code 当成页面原值与材料中文值比较。
    const role = String(control?.getAttribute?.("role") || "").toLowerCase();
    if (role === "combobox" || control?.getAttribute?.("aria-controls") || control?.getAttribute?.("aria-owns")) {
      const item = control.closest?.(FORM_ITEM_SELECTOR);
      const selected = visibleText(item?.querySelector?.(
        ".ant-select-selection-item, .el-select__selected-item, .el-input__inner",
      ));
      if (isUsableValue(selected)) return selected;
    }
    return String(control?.value ?? control?.textContent ?? "").trim();
  };

  const findSection = (element) => {
    const fixtureSection = element?.dataset?.reviewSection;
    if (fixtureSection && fixtureSection !== "unknown") return fixtureSection;

    // Stop before the document body: broad container text can mention both old
    // and new vehicles and would incorrectly assign repeated labels.
    let current = element;
    for (let level = 0; current && level < 8; level += 1, current = current.parentElement) {
      if (["BODY", "HTML"].includes(current.tagName)) break;
      const ownSection = sectionFromText(
        `${directText(current)} ${current.getAttribute?.("aria-label") || ""}`,
      );
      if (ownSection !== "unknown") return ownSection;

      const headingText = directElementChildren(current)
        .filter((child) => /^(H[1-6]|LEGEND)$/.test(child.tagName))
        .map(visibleText)
        .join(" ");
      const headingSection = sectionFromText(headingText);
      if (headingSection !== "unknown") return headingSection;

      const shortChildTitleText = directElementChildren(current)
        .map(visibleText)
        .filter((text) => text.length > 0 && text.length <= 40)
        .join(" ");
      const childTitleSection = sectionFromText(shortChildTitleText);
      if (childTitleSection !== "unknown") return childTitleSection;
    }
    return "unknown";
  };

  const controlLabel = (root, control) => {
    const labels = [];
    if (control.id && root?.querySelectorAll) {
      const escapedId = globalThis.CSS?.escape ? globalThis.CSS.escape(control.id) : control.id;
      queryAll(root, `label[for="${escapedId}"]`).forEach((label) => labels.push(visibleText(label)));
    }
    const formItem = control.closest?.(FORM_ITEM_SELECTOR);
    const wrappingLabel = control.closest?.("label");
    const itemLabel = formItem?.querySelector?.(
      ".ant-form-item-label label, .el-form-item__label, label",
    );
    labels.push(
      visibleText(itemLabel),
      visibleText(wrappingLabel),
      control.getAttribute?.("aria-label") || "",
      control.getAttribute?.("name") || "",
    );
    // Use one authoritative association. Concatenating for/item/aria labels
    // downgrades a control to a fuzzy match and lets its wrapper text win.
    return (labels.find((label) => String(label).trim())?.trim() || "")
      .replace(/\s*(?:不一致|易混淆|一致)\s*$/, "")
      .trim();
  };

  const controlCandidates = (root, controls = queryAll(root, CONTROL_SELECTOR)) =>
    controls
      .filter(isDataControl)
      .flatMap((control) => {
        const label = controlLabel(root, control);
        const value = readControlValue(control);
        const section = findSection(control);
        const candidate = {
          label,
          value,
          section,
          source: "control",
          element: control,
          proximity: visibleText(control.parentElement).length,
        };
        const nearbyText = visibleText(control.parentElement) + visibleText(control.parentElement?.parentElement);
        const controlType = String(control.getAttribute?.("type") || "").toLowerCase();
        const isDateControl = controlType === "date" || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(String(value));
        const fallback = isDateControl && /开票日期|发票日期/.test(`${label}${nearbyText}`)
          ? [{ ...candidate, label: "开票日期", source: "control-fallback" }]
          : [];
        return [candidate, ...fallback];
      })
      .filter((candidate) => candidate.label && (
        isUsableValue(candidate.value) ||
        writableTargetField(candidate.label) ||
        isKnownLabel(candidate.label)
      ))
      .filter((candidate) => !isVerificationCandidate(candidate));

  const isEditableControl = (control) => {
    const type = String(control?.getAttribute?.("type") || "").toLowerCase();
    if (["hidden", "button", "submit", "reset", "image"].includes(type)) return false;
    if (control?.hidden === true || control?.disabled === true) return false;
    if (control?.getAttribute?.("aria-hidden") === "true" || control?.getAttribute?.("aria-disabled") === "true") return false;
    for (let node = control; node; node = node.parentElement) {
      if (node.hidden === true || node.getAttribute?.("aria-hidden") === "true") return false;
      if (node.style?.display === "none" || node.style?.visibility === "hidden") return false;
      const getComputedStyle = node.ownerDocument?.defaultView?.getComputedStyle;
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle.call(node.ownerDocument.defaultView, node);
        if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
      }
    }
    const role = String(control?.getAttribute?.("role") || "").toLowerCase();
    const customEditable = role === "combobox" || control?.getAttribute?.("contenteditable") === "true";
    return customEditable || (control?.readOnly !== true && control?.getAttribute?.("readonly") == null);
  };

  const controlType = (control) => {
    const role = String(control?.getAttribute?.("role") || "").toLowerCase();
    if (role === "combobox" || control?.tagName === "SELECT") return "select";
    if (control?.tagName === "TEXTAREA") return "textarea";
    if (control?.getAttribute?.("contenteditable") === "true") return "contenteditable";
    return String(control?.getAttribute?.("type") || "text").toLowerCase() || "text";
  };

  const displayLabel = (label) => String(label || "")
    .replace(/[＊*]/g, "")
    .replace(/[：:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  const readInventoryValue = (control) => {
    const direct = readControlValue(control);
    if (isUsableValue(direct)) return direct;
    const container = control.closest?.(FORM_ITEM_SELECTOR);
    const selected = visibleText(container?.querySelector?.(
      ".ant-select-selection-item, .el-select__selected-item, .el-input__inner",
    ));
    return isUsableValue(selected) ? selected : "";
  };

  const directElementChildren = (element) => Array.from(element?.children || []);

  const structuredCandidatesForContainer = (container) => {
    // A form value comes from the live control, never its decorated wrapper
    // (validation badges, duplicated highlight overlays, buttons, etc.).
    if (queryAll(container, CONTROL_SELECTOR).some(isDataControl)) return [];
    const children = directElementChildren(container);
    const cells = children.filter((child) => ["TH", "TD"].includes(child.tagName));
    if (cells.length >= 2) {
      const candidates = [];
      for (let index = 0; index + 1 < cells.length; index += 2) {
        candidates.push({
          label: visibleText(cells[index]),
          value: visibleText(cells[index + 1]),
          section: findSection(container),
          source: "table",
          element: cells[index + 1],
          proximity: visibleText(container).length,
        });
      }
      return candidates;
    }

    const labelNode = container.querySelector?.(
      ":scope > dt, :scope > label, .ant-descriptions-item-label, .el-descriptions__label, .ant-form-item-label, .el-form-item__label",
    );
    const valueNode = container.querySelector?.(
      ":scope > dd, .ant-descriptions-item-content, .el-descriptions__content, .ant-form-item-control, .el-form-item__content, .field-value, .value",
    );
    if (labelNode && valueNode) {
      return [{
        label: visibleText(labelNode),
        value: visibleText(valueNode),
        section: findSection(container),
        source: "structured",
        element: valueNode,
        proximity: visibleText(container).length,
      }];
    }

    if (children.length === 2 && (isKnownLabel(visibleText(children[0])) || writableTargetField(visibleText(children[0])))) {
      return [{
        label: visibleText(children[0]),
        value: visibleText(children[1]),
        section: findSection(container),
        source: "structured",
        element: children[1],
        proximity: visibleText(container).length,
      }];
    }
    return [];
  };

  const structuredCandidates = (root) =>
    queryAll(
      root,
      `tr, dl > div, .ant-descriptions-item, .el-descriptions__row, ${FORM_ITEM_SELECTOR}`,
    )
      .flatMap(structuredCandidatesForContainer)
      .filter((candidate) => candidate.label && (isUsableValue(candidate.value) || writableTargetField(candidate.label)));

  const adjacentCandidates = (root) => {
    const candidates = [];
    for (const element of queryAll(root, "body *, *")) {
      const ownText = directText(element);
      const inlineMatch = ownText.match(/^\s*([^：:]+)[：:]\s*(.+)\s*$/);
      if (inlineMatch && isKnownLabel(inlineMatch[1])) {
        candidates.push({
          label: inlineMatch[1],
          value: inlineMatch[2],
          section: findSection(element),
          source: "inline",
          element,
          proximity: ownText.length,
        });
        continue;
      }
      if (!isKnownLabel(ownText) && !writableTargetField(ownText)) continue;
      if (queryAll(element.nextElementSibling, CONTROL_SELECTOR).some(isDataControl)) continue;
      const value = visibleText(element.nextElementSibling);
      if ((!isUsableValue(value) && !writableTargetField(ownText)) || value.length > 200) continue;
      candidates.push({
        label: ownText,
        value,
        section: findSection(element),
        source: "adjacent",
        element: element.nextElementSibling,
        proximity: value.length,
      });
    }
    return candidates;
  };

  const matchingScore = (field, definition, candidate, businessType = null) => {
    const label = normalizeText(candidate.label);
    let exact = true;
    let aliasIndex = definition.aliases.findIndex((alias) => normalizeText(alias) === label);
    if (aliasIndex < 0) {
      exact = false;
      aliasIndex = definition.aliases.findIndex((alias) => label.includes(normalizeText(alias)));
    }
    if (aliasIndex < 0) return null;
    if (!String(candidate.value || "").trim() && !String(candidate.source || "").startsWith("control")) return null;
    const confirmedTransferField =
      businessType === "transfer" && definition.section === "transfer";
    if (
      candidate.section !== "unknown" &&
      candidate.section !== definition.section &&
      !(confirmedTransferField && candidate.section === "unknown")
    ) return null;
    const matchedAlias = normalizeText(definition.aliases[aliasIndex]);
    const aliasFieldCount = Object.values(FIELD_DEFINITIONS).filter((item) =>
      item.aliases.some((alias) => normalizeText(alias) === matchedAlias),
    ).length;
    // Confirmed transfer pages place fields such as publish date outside the
    // voucher container, so unique transfer labels may use an unknown section.
    if (
      aliasFieldCount > 1 &&
      candidate.section === "unknown" &&
      !confirmedTransferField
    ) return null;

    return (
      (exact ? 10_000 : 5_000) -
      (aliasFieldCount > 1 ? 1_000 : 0) +
      (candidate.section === definition.section ? 500 : 0) +
      (SOURCE_SCORES[candidate.source] || 0)
    );
  };

  const resolveInventoryField = (candidate, businessType) => {
    const ranked = Object.entries(FIELD_DEFINITIONS)
      .map(([field, definition]) => ({
        field,
        definition,
        score: matchingScore(
          field,
          definition,
          { ...candidate, value: candidate.value || "__empty_control__" },
          businessType,
        ),
      }))
      .filter((item) => item.score != null)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked.filter((item) => item.score === ranked[0].score).length !== 1) return null;
    return ranked[0];
  };

  const reviewFieldInventory = (root, controls, businessType) => {
    const seenLogicalControls = new Set();
    const inventory = [];
    for (const control of controls) {
      const label = controlLabel(root, control);
      if (!label) continue;
      if (isSearchFilterControl(control) || isSystemControlLabel(label)) continue;
      const container = control.closest?.(FORM_ITEM_SELECTOR) || control;
      if (seenLogicalControls.has(container)) continue;
      seenLogicalControls.add(container);
      const candidate = {
        label,
        value: readInventoryValue(control),
        section: findSection(control),
        source: "control",
      };
      const operationField = writableTargetField(label);
      const operationLabel = operationField
        ? Object.entries(WRITABLE_TARGETS).find(([, field]) => field === operationField)?.[0]
        : null;
      const resolved = operationField ? null : resolveInventoryField(candidate, businessType);
      if (resolved?.definition.reviewable === false) continue;
      // 隐藏控件不是当前详情字段；只读的已知字段（日期等）仍需进入审核目录，
      // 但会以 editable=false 传给后端，避免提供页面回写按钮。
      if (!isEditableControl(control) && !resolved && !operationField) continue;
      inventory.push({
        field: operationField || resolved?.field || null,
        label: operationLabel || resolved?.definition.aliases[0] || displayLabel(label),
        value: candidate.value,
        controlType: controlType(control),
        editable: isEditableControl(control),
        section: candidate.section,
        operationOnly: Boolean(operationField),
      });
    }

    // Repeated controls with the same canonical field cannot be mapped safely.
    const mappedCounts = inventory.reduce((counts, item) => {
      if (item.field) counts.set(item.field, (counts.get(item.field) || 0) + 1);
      return counts;
    }, new Map());
    return inventory.map((item, index) => ({
      ...item,
      field: item.field && mappedCounts.get(item.field) === 1 ? item.field : null,
      order: index + 1,
    }));
  };

  const reviewRoot = (root) => {
    // 列表筛选区与审核详情区存在重复 id/label，优先采集实际审核详情弹层。
    // 没有打开详情时保留传入 root，兼容普通页面和测试 fixture。
    const modalCandidates = queryAll(root, ".my-page-modal").filter((item) =>
      item.querySelector?.(".largeForm"),
    );
    const modal = modalCandidates[modalCandidates.length - 1];
    if (modal) return modal.querySelector(".largeForm") || modal;
    const fallback = root?.querySelector?.(
      ".my-page-modal .largeForm, .my-page-modal-body .largeForm, .my-page-modal",
    );
    return fallback || root;
  };

  const collectCandidates = (candidates, scannedControls = 0, businessType = null, reviewFields = []) => {
    const pageFields = {};
    const fieldTargets = [];
    const unmatchedLabels = [];
    const ambiguousFields = [];
    const writableTargets = Object.entries(WRITABLE_TARGETS).flatMap(([label, field]) => {
      // 页面有时会把表单项标签和控件占位文本拼接成“报废车挂靠 报废车挂靠”。
      // 与 writableTargetField 使用同一套前缀匹配，避免控件已识别但自动填写目标丢失。
      const targets = candidates.filter((candidate) => writableTargetField(candidate.label) === field);
      if (targets.length !== 1) {
        if (targets.length > 1) ambiguousFields.push(field);
        return [];
      }
      const [target] = targets;
      if (target.element) fieldTargets.push({ field, element: target.element });
      const currentValue = String(target.value || "").trim() || null;
      return [{ field, label, present: true, currentValue }];
    });
    // reviewFieldInventory is built from the same logical form item and is a
    // fallback when the label/value candidate is represented by a custom
    // control that does not expose a normal candidate value.
    for (const target of reviewFields.filter((item) => item.operationOnly && item.field)) {
      if (!writableTargets.some((item) => item.field === target.field)) {
        writableTargets.push({
          field: target.field,
          label: Object.entries(WRITABLE_TARGETS).find(([, field]) => field === target.field)?.[0] || target.label,
          present: true,
          currentValue: String(target.value || "").trim() || null,
        });
      }
    }

    for (const [field, definition] of Object.entries(FIELD_DEFINITIONS)) {
      const ranked = candidates
        .map((candidate) => ({
          candidate,
          score: matchingScore(field, definition, candidate, businessType),
        }))
        .filter((item) => item.score != null)
        .sort((left, right) => right.score - left.score);

      if (!ranked.length) {
        unmatchedLabels.push(definition.aliases[0]);
        continue;
      }

      const top = ranked.filter((item) => item.score === ranked[0].score);
      // Preserve equally reliable candidates for manual review instead of guessing by value length.
      // Equally ranked duplicates stay ambiguous even when values agree, so a review
      // marker can never be mapped onto the wrong element.
      if (top.length > 1) {
        ambiguousFields.push(field);
        unmatchedLabels.push(definition.aliases[0]);
        continue;
      }
      const [accepted] = top;
      pageFields[field] = accepted.candidate.value;
      if (accepted.candidate.element) {
        fieldTargets.push({ field, element: accepted.candidate.element });
      }
    }

    if (!pageFields["invoice.invoice_date"] && businessType !== "transfer") {
      const dateCandidates = candidates.filter((candidate) =>
        /开票日期|发票日期/.test(normalizeText(candidate.label)) &&
        /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(candidate.value || "")),
      );
      const fallback = dateCandidates.find((candidate) => candidate.section === "new_vehicle")
        || dateCandidates.find((candidate) => candidate.section !== "transfer");
      if (fallback) {
        pageFields["invoice.invoice_date"] = fallback.value;
        if (dateCandidates.length === 1 && fallback.element) {
          fieldTargets.push({ field: "invoice.invoice_date", element: fallback.element });
        }
        const unmatchedIndex = unmatchedLabels.indexOf("开票日期");
        if (unmatchedIndex >= 0) unmatchedLabels.splice(unmatchedIndex, 1);
      }
    }

    return {
      pageFields,
      fieldTargets,
      writableTargets,
      unmatchedLabels,
      ambiguousFields,
      candidateCount: candidates.length,
      scannedControls,
      reviewFields,
    };
  };

  const collect = (root, businessType = null) => {
    const scopedRoot = reviewRoot(root);
    const rawControls = queryAll(scopedRoot, CONTROL_SELECTOR)
      .filter((control) => isDataControl(control) && !isSearchFilterControl(control));
    const controls = controlCandidates(scopedRoot, rawControls);
    const reviewFields = reviewFieldInventory(scopedRoot, rawControls, businessType);
    const inSearchFilter = (candidate) => isSearchFilterControl(candidate.element);
    return collectCandidates(
      [
        ...controls,
        ...structuredCandidates(scopedRoot),
        ...adjacentCandidates(scopedRoot),
      ].filter((candidate) => !inSearchFilter(candidate) && !isSystemControlLabel(candidate.label) && !isVerificationCandidate(candidate)),
      rawControls.length,
      businessType,
      reviewFields,
    );
  };

  globalThis.ReviewPageFieldCollector = {
    collect,
    collectCandidates,
    definitionForLabel,
    isSectionRequired,
    sectionFromText,
  };
})();
