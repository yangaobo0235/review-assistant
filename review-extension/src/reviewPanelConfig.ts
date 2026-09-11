/**
 * 功能：集中维护业务、字段和状态展示标签。
 * 职责边界：不包含审核判定逻辑。
 * 修改日期：2026-08-26
 * 修改人：wuyi
 */

import type {
  BusinessSelection,
  BusinessType,
  FieldComparison,
  JobStatus,
} from "./types/review";

export type BusinessChoice =
  | "AUTO"
  | "scrap_replacement_qingdao"
  | "scrap_replacement_changchun"
  | "consistency_qingdao"
  | "consistency_changchun"
  | "vehicle_source"
  | "transfer";

export const businessLabels: Record<BusinessChoice, string> = {
  AUTO: "自动识别",
  scrap_replacement_qingdao: "青岛报废置换审核",
  scrap_replacement_changchun: "长春报废置换审核",
  vehicle_source: "车源审核",
  transfer: "过户审核",
  consistency_qingdao: "青岛一致性审核",
  consistency_changchun: "长春一致性审核",
};

const fieldLabels: Record<string, string> = {
  "old_vehicle.recycle_date": "报废交车日期",
  "old_vehicle.vin": "报废车辆车架号",
  "old_vehicle.plate_no": "报废车辆车牌号",
  "old_vehicle.owner": "报废车辆所有人",
  "old_vehicle.engine_model": "报废发动机型号",
  "invoice.code": "发票代码",
  "invoice.amount": "开票金额",
  "invoice.invoice_date": "开票日期",
  "new_vehicle.vin": "新车车架号",
  "new_vehicle.plate_no": "新车车牌号",
  "new_vehicle.owner": "新车所有人",
  "transfer.plate_no": "车牌号",
  "transfer.vin": "车架号",
  "transfer.buyer_name": "过户发票买方名称",
  "transfer.seller_name": "卖方名称",
  "transfer.invoice_date": "开票日期",
};

export function manualBusinessSelection(
  choice: Exclude<BusinessChoice, "AUTO">,
): BusinessSelection {
  const region = choice.endsWith("_qingdao")
    ? "qingdao"
    : choice.endsWith("_changchun")
      ? "changchun"
      : "default";
  const businessType: BusinessType = choice.startsWith("scrap_replacement")
    ? "scrap_replacement"
    : choice.startsWith("consistency")
      ? "consistency"
      : choice as BusinessType;
  return {
    businessType,
    region,
    profileVersion: "1.0",
    workflowStage: businessType,
    selectionMode: "MANUAL",
  };
}

export function fieldLabel(field: string): string {
  return fieldLabels[field] ?? field;
}

export function statusLabel(status: FieldComparison["status"]): string {
  switch (status) {
    case "MATCH":
      return "一致";
    case "CONFLICT":
      return "冲突";
    case "REVIEW_REQUIRED":
      return "待复核";
  }
}

export function groupStatusLabel(status?: JobStatus): string {
  switch (status) {
    case "COMPLETED":
      return "已完成";
    case "PARTIAL":
      return "部分完成";
    case "FAILED":
      return "处理失败";
    case "RUNNING":
    case undefined:
      return "识别中";
  }
}
