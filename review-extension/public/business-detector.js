/**
 * 功能：根据路由和唯一页面指纹识别审核业务。
 * 职责边界：识别不可靠时返回未知，不静默选择业务。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

(function attachBusinessDetector(globalObject) {
  const profile = (businessType, region) => ({
    businessType,
    region,
    profileVersion: "1.0",
    workflowStage: businessType,
    selectionMode: "AUTO",
    detectionStatus: "CONFIRMED",
  });

  const routeMatchers = [
    {
      prefix: "/scrap-replace-qingdao",
      result: profile("scrap_replacement", "qingdao"),
    },
    {
      prefix: "/vehicle-source",
      result: profile("vehicle_source", "default"),
    },
    {
      prefix: "/consistency-qingdao",
      result: profile("consistency", "qingdao"),
    },
  ];

  const fingerprintMatchers = [
    {
      matches: (text) => text.includes("报废车辆信息") && text.includes("报废证明编号"),
      result: profile("scrap_replacement", "qingdao"),
    },
    {
      matches: (text) => text.includes("车源审核") && text.includes("车辆来源信息"),
      result: profile("vehicle_source", "default"),
    },
    {
      matches: (text) => text.includes("一致性审核"),
      result: profile("consistency", "qingdao"),
    },
    {
      matches: (text) => text.includes("过户审核"),
      result: profile("transfer", "default"),
    },
  ];

  const isTransferVoucher = (text) =>
    text.includes("审核过户凭证") &&
    text.includes("过户发票买家名称") &&
    text.includes("卖方名称");

  function detect(url, pageText = "") {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    if (isTransferVoucher(pageText)) return { ...profile("transfer", "default") };
    const route = routeMatchers.find((candidate) => path.startsWith(candidate.prefix));
    if (route) return { ...route.result };

    const fingerprint = fingerprintMatchers.find((candidate) => candidate.matches(pageText));
    return fingerprint ? { ...fingerprint.result } : null;
  }

  globalObject.ReviewBusinessDetector = { detect };
})(globalThis);
