/**
 * 功能：过滤、评分并覆盖选择业务材料图片。
 * 职责边界：只选择候选，不读取或压缩图片字节。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

(() => {
  const knownTypes = new Set(["scrap_certificate", "old_vehicle", "registration_certificate", "new_vehicle", "invoice", "business_license", "id_card"]);
  const decorativePattern = /(?:^|[-_\s])(logo|icon|avatar|favicon|badge|spinner)(?:$|[-_\s])/i;
  const businessPattern = /回收证明|报废证明|报废车辆资料|旧车资料|登记证书|机动车登记证|新车资料|发票|营业执照|身份证/;
  const eligible = (candidate) => {
    if (!candidate.src || !candidate.visible || candidate.ariaHidden) return false;
    if (candidate.businessScope === "other") return false;
    if (candidate.role === "presentation" || candidate.emptySlot) return false;
    if (decorativePattern.test(candidate.className || "")) return false;
    const width = Number(candidate.naturalWidth || 0);
    const height = Number(candidate.naturalHeight || 0);
    if (!knownTypes.has(candidate.categoryHint) && width * height < 40_000) return false;
    return knownTypes.has(candidate.categoryHint) || businessPattern.test(candidate.hint || "") || width * height >= 40_000;
  };

  const score = (candidate) => {
    const scopeScore = ["old_vehicle", "new_vehicle"].includes(candidate.businessScope) ? 10_000_000 : 0;
    const knownScore = knownTypes.has(candidate.categoryHint) ? 1_000_000 : 0;
    const businessScore = businessPattern.test(candidate.hint || "") ? 100_000 : 0;
    const areaScore = Math.min(Number(candidate.naturalWidth || 0) * Number(candidate.naturalHeight || 0), 99_999);
    return scopeScore + knownScore + businessScore + areaScore;
  };

  const coverageKey = (candidate) =>
    `${candidate.businessScope || "unknown"}::${candidate.categoryHint || "unknown"}::${candidate.groupTitle || ""}`;

  const select = (candidates, limit = 10) => {
    const ranked = candidates
      .filter(eligible)
      .map((candidate) => ({ candidate, rank: score(candidate) }))
      .sort((left, right) => right.rank - left.rank || left.candidate.index - right.candidate.index)
      .map((item) => item.candidate);
    const reservedByBucket = new Map();
    for (const candidate of ranked) {
      const key = coverageKey(candidate);
      if (!reservedByBucket.has(key)) reservedByBucket.set(key, candidate);
    }
    const selectedCandidates = new Set(
      Array.from(reservedByBucket.values()).slice(0, limit),
    );
    for (const candidate of ranked) {
      if (selectedCandidates.size >= limit) break;
      selectedCandidates.add(candidate);
    }
    return {
      selected: ranked.filter((candidate) => selectedCandidates.has(candidate)).slice(0, limit),
      overflow: ranked.length > limit,
      scannedCount: candidates.length,
      eligibleCount: ranked.length
    };
  };

  globalThis.ReviewImageCandidates = { select };
})();
