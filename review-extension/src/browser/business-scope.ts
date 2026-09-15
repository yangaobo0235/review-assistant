
/**
 * 功能：根据页面结构判定材料的业务归属。
 * 职责边界：不把身份或无关区域归入审核材料。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */


  const normalize = (value: unknown) => String(value || "").replace(/\s+/g, "").replace(/[：:]+$/, "");

  const labels = new Map([
    ["报废车辆资料", { scope: "old_vehicle", title: "报废车辆资料" }],
    // 生产报废置换页使用“报废车辆信息”作为分组标题；两种标题
    // 指向同一个旧车材料槽位，不能因为文案不同而丢失业务分区。
    ["报废车辆信息", { scope: "old_vehicle", title: "报废车辆信息" }],
    ["报废车资料", { scope: "old_vehicle", title: "报废车资料" }],
    ["旧车资料", { scope: "old_vehicle", title: "旧车资料" }],
    ["新车资料", { scope: "new_vehicle", title: "新车资料" }],
    ["新车及发票信息", { scope: "new_vehicle", title: "新车及发票信息" }],
    ["新车及发票资料", { scope: "new_vehicle", title: "新车及发票资料" }],
    ["发票资料", { scope: "new_vehicle", title: "发票资料" }],
    ["营业执照", { scope: "business_license", title: "营业执照" }],
    ["身份证正面", { scope: "identity", title: "身份证正面" }],
    ["身份证反面", { scope: "identity", title: "身份证反面" }],
    ["身份证", { scope: "identity", title: "身份证" }],
    ["其他图片", { scope: "other", title: "其他图片" }],
  ]);

  const physicalDocumentTypes = new Map([
    ["scrap_certificate", "scrap_certificate"],
    ["vehicle_license", "vehicle_license"],
    ["registration_certificate", "registration_certificate"],
    ["invoice", "invoice"],
    ["business_license", "business_license"],
    ["id_card", "identity_card"],
    ["identity_card", "identity_card"],
  ]);
  const slotDocumentTypes = new Map([
    ["old_vehicle:1", "vehicle_license"],
    ["old_vehicle:2", "registration_certificate"],
    ["old_vehicle:3", "scrap_certificate"],
    ["new_vehicle:1", "vehicle_license"],
    ["new_vehicle:2", "registration_certificate"],
    ["new_vehicle:3", "invoice"],
  ]);

  const scopeForLabel = (text: string) => labels.get(normalize(text)) || null;

  const documentTypeFor = (businessScope: string, groupOrder: number, categoryHint: string) =>
    physicalDocumentTypes.get(String(categoryHint || ""))
    || slotDocumentTypes.get(`${businessScope || "unknown"}:${groupOrder || 0}`)
    || "unknown";

  const assign = (items: ({ kind: "label"; text: string } | { kind: "image"; index: number })[]) => {
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

  export const ReviewBusinessScope = { scopeForLabel, assign, documentTypeFor };
