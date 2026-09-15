import type { EvidenceFact } from "../types/review.ts";


  const documentNames: Record<string, string> = {
    vehicle_license: "行驶证",
    registration_certificate: "机动车登记证书",
    scrap_certificate: "报废机动车回收证明",
    invoice: "机动车销售发票",
  };

  const label = (evidence: EvidenceFact) => {
    if (evidence.group_title && evidence.group_order) {
      const documentName = documentNames[evidence.document_type ?? ""] || "车辆资料";
      return `${evidence.group_title} · 第${evidence.group_order}张 · ${documentName}`;
    }
    if (evidence.image_index != null && Number.isInteger(evidence.image_index)) return `图片 #${evidence.image_index + 1}`;
    return "图片识别";
  };

  export const ReviewEvidenceLabel = { label, documentNames };
