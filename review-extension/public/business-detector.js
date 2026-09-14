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
      prefix: "/scrap-replace-changchun",
      result: profile("scrap_replacement", "changchun"),
    },
    {
      prefix: "/vehicle-source",
      result: profile("vehicle_source", "default"),
    },
    {
      prefix: "/consistency-qingdao",
      result: profile("consistency", "qingdao"),
    },
    {
      prefix: "/consistency-changchun",
      result: profile("consistency", "changchun"),
    },
  ];

  const fingerprintMatchers = [
    {
      matches: (text) => text.includes("车源审核") && text.includes("车辆来源信息"),
      result: profile("vehicle_source", "default"),
    },
  ];

  function detect(url, pageText = "") {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    const route = routeMatchers.find((candidate) =>
      path === candidate.prefix || path.startsWith(`${candidate.prefix}/`),
    );
    if (route) return { ...route.result };

    const fingerprint = fingerprintMatchers.find((candidate) => candidate.matches(pageText));
    return fingerprint ? { ...fingerprint.result } : null;
  }

  function resolve(url, pageText = "", manualSelection = null) {
    const automatic = detect(url, pageText);
    if (!manualSelection) return { business: automatic, error: automatic ? null : "无法识别当前审核业务，请人工选择" };
    if (
      automatic &&
      (automatic.businessType !== manualSelection.businessType || automatic.region !== manualSelection.region)
    ) {
      return { business: null, error: "人工选择的审核地区与当前页面不一致，请重新确认" };
    }
    return {
      business: {
        ...manualSelection,
        selectionMode: "MANUAL",
        detectionStatus: "CONFIRMED",
      },
      error: null,
    };
  }

  globalObject.ReviewBusinessDetector = { detect, resolve };
})(globalThis);
