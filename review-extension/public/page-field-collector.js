/**
 * 功能：从表单、表格和只读 DOM 提取标准字段候选。
 * 职责边界：同等可靠候选冲突时保留歧义，不猜测值。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

(() => {
  const FIELD_DEFINITIONS = {
    "application.id": {
      aliases: ["申请单ID", "申请单编号"],
      section: "unknown",
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
  const CONTROL_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
  const WRITABLE_TARGETS = {
    "报废车挂靠": "old_vehicle.affiliation",
    "新车挂靠": "new_vehicle.affiliation",
  };

  const normalizeText = (value) => String(value || "")
    .replace(/[＊*]/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:]$/, "");
  const PLACEHOLDER_VALUES = new Set(["审核进度", "待审核", "审核中", "处理中", "未审核"]);
  const isUsableValue = (value) => {
    const normalized = normalizeText(value);
    return Boolean(normalized) && !PLACEHOLDER_VALUES.has(normalized);
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
    const hasOld = /报废车辆信息|报废车辆资料|旧车资料/.test(value);
    const hasNew = /新车及发票信息|新车资料|发票信息/.test(value);
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

  const writableTargetField = (label) => WRITABLE_TARGETS[normalizeText(label)] || null;

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
    const formItem = control.closest?.(".ant-form-item, .el-form-item, .form-item");
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
    return labels.filter(Boolean).join(" ").trim();
  };

  const controlCandidates = (root) =>
    queryAll(root, CONTROL_SELECTOR)
      .flatMap((control) => {
        const label = controlLabel(root, control);
        const value = readControlValue(control);
        const section = findSection(control);
        const candidate = {
          label,
          value,
          section,
          source: "control",
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
      .filter((candidate) => candidate.label && (isUsableValue(candidate.value) || writableTargetField(candidate.label)));

  const directElementChildren = (element) => Array.from(element?.children || []);

  const structuredCandidatesForContainer = (container) => {
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
        proximity: visibleText(container).length,
      }];
    }

    if (children.length === 2 && (isKnownLabel(visibleText(children[0])) || writableTargetField(visibleText(children[0])))) {
      return [{
        label: visibleText(children[0]),
        value: visibleText(children[1]),
        section: findSection(container),
        source: "structured",
        proximity: visibleText(container).length,
      }];
    }
    return [];
  };

  const structuredCandidates = (root) =>
    queryAll(
      root,
      "tr, dl > div, .ant-descriptions-item, .el-descriptions__row, .ant-form-item, .el-form-item, .form-item",
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
          proximity: ownText.length,
        });
        continue;
      }
      if (!isKnownLabel(ownText) && !writableTargetField(ownText)) continue;
      const value = visibleText(element.nextElementSibling);
      if ((!isUsableValue(value) && !writableTargetField(ownText)) || value.length > 200) continue;
      candidates.push({
        label: ownText,
        value,
        section: findSection(element),
        source: "adjacent",
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
    if (aliasIndex < 0 || !String(candidate.value || "").trim()) return null;
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

  const collectCandidates = (candidates, scannedControls = 0, businessType = null) => {
    const pageFields = {};
    const unmatchedLabels = [];
    const ambiguousFields = [];
    const writableTargets = Object.entries(WRITABLE_TARGETS).flatMap(([label, field]) => {
      const targets = candidates.filter((candidate) => normalizeText(candidate.label) === label);
      if (targets.length !== 1) {
        if (targets.length > 1) ambiguousFields.push(field);
        return [];
      }
      const [target] = targets;
      const currentValue = String(target.value || "").trim() || null;
      return [{ field, label, present: true, currentValue }];
    });

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
      // Preserve equally reliable conflicting candidates for manual review instead of guessing by value length.
      const values = new Set(top.map((item) => String(item.candidate.value).trim()));
      if (values.size > 1) {
        ambiguousFields.push(field);
        unmatchedLabels.push(definition.aliases[0]);
        continue;
      }
      pageFields[field] = top[0].candidate.value;
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
        const unmatchedIndex = unmatchedLabels.indexOf("开票日期");
        if (unmatchedIndex >= 0) unmatchedLabels.splice(unmatchedIndex, 1);
      }
    }

    return {
      pageFields,
      writableTargets,
      unmatchedLabels,
      ambiguousFields,
      candidateCount: candidates.length,
      scannedControls,
    };
  };

  const collect = (root, businessType = null) => {
    const controls = controlCandidates(root);
    return collectCandidates(
      [
        ...controls,
        ...structuredCandidates(root),
        ...adjacentCandidates(root),
      ],
      queryAll(root, CONTROL_SELECTOR).length,
      businessType,
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
