(() => {
  const expectedSection = (field) => {
    if (field.startsWith("old_vehicle.") || field.startsWith("scrap_certificate.")) return "old_vehicle";
    if (field.startsWith("new_vehicle.") || field.startsWith("invoice.")) return "new_vehicle";
    return "unknown";
  };

  const select = (field, aliases, candidates) => {
    const expected = expectedSection(field);
    const ranked = [];
    for (const candidate of candidates) {
      if (!candidate.value) continue;
      if (expected !== "unknown" && candidate.section && candidate.section !== "unknown" && candidate.section !== expected) continue;
      for (const alias of aliases) {
        const label = (candidate.label || "").replace(/\s+/g, "");
        const context = (candidate.context || "").replace(/\s+/g, "");
        const target = alias.replace(/\s+/g, "");
        let score = 0;
        if (label === target || label === `${target}:` || label === `${target}：`) score = 30_000;
        else if (label.includes(target)) score = 20_000;
        else if (context.includes(target)) score = 1_000;
        if (!score) continue;
        if (candidate.section === expected) score += 10_000;
        score += target.length;
        ranked.push({ candidate, score });
      }
    }
    ranked.sort((left, right) => right.score - left.score || left.candidate.context.length - right.candidate.context.length);
    return ranked[0]?.candidate || null;
  };

  globalThis.ReviewFieldMatcher = { select };
})();
