/**
 * 功能：根据页面结构判定材料的业务归属。
 * 职责边界：不把身份或无关区域归入审核材料。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

(() => {
  const normalize = (value) => String(value || "").replace(/\s+/g, "").replace(/[：:]+$/, "");

  const labels = new Map([
    ["报废车辆资料", { scope: "old_vehicle", title: "报废车辆资料" }],
    ["旧车资料", { scope: "old_vehicle", title: "旧车资料" }],
    ["新车资料", { scope: "new_vehicle", title: "新车资料" }],
    ["发票资料", { scope: "new_vehicle", title: "发票资料" }],
    ["过户资料", { scope: "transfer", title: "过户资料" }],
    ["营业执照", { scope: "business_license", title: "营业执照" }],
    ["身份证正面", { scope: "other", title: "身份证正面" }],
    ["身份证反面", { scope: "other", title: "身份证反面" }],
    ["身份证", { scope: "other", title: "身份证" }],
    ["其他图片", { scope: "other", title: "其他图片" }],
  ]);

  const scopeForLabel = (text) => labels.get(normalize(text)) || null;

  const assign = (items) => {
    let active = { scope: "unknown", title: "未分类资料" };
    const counters = new Map();
    const assigned = [];
    for (const item of items) {
      if (item.kind === "label") {
        const next = scopeForLabel(item.text);
        if (next) active = next;
        continue;
      }
      if (item.kind !== "image") continue;
      const order = (counters.get(active.scope) || 0) + 1;
      counters.set(active.scope, order);
      assigned.push({
        index: item.index,
        businessScope: active.scope,
        groupTitle: active.title,
        groupOrder: order,
        imageId: `${active.scope}-${String(order).padStart(2, "0")}`,
      });
    }
    return assigned;
  };

  globalThis.ReviewBusinessScope = { scopeForLabel, assign };
})();
