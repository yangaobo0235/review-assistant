"""报废置换审核的主要字段清单及展示名称。"""

OLD_VEHICLE_FIELDS = (
    "old_vehicle.type",
    "old_vehicle.recycle_date",
    "scrap_certificate.certificate_no",
    "old_vehicle.vin",
    "old_vehicle.plate_no",
    "old_vehicle.owner",
    "old_vehicle.engine_model",
)

NEW_VEHICLE_AND_INVOICE_FIELDS = (
    "new_vehicle.fuel_type",
    "invoice.code",
    "invoice.invoice_no",
    "invoice.amount",
    "invoice.invoice_date",
    "new_vehicle.vin",
    "new_vehicle.plate_no",
    "new_vehicle.owner",
    "new_vehicle.registration_date",
    "application.terminal_certificate_no",
    "application.customer_name",
    "application.terminal_phone",
)

PRIMARY_REVIEW_FIELDS = OLD_VEHICLE_FIELDS + NEW_VEHICLE_AND_INVOICE_FIELDS

# 报废置换页面控件的已知语义。实际字段数量和顺序来自每次 DOM 采集，
# 不能用本表推导页面字段总数。
SCRAP_PAGE_FIELD_LABELS = {
    "application.submitted_at": "申请时间",
    "application.owner_type": "车辆所有人类型",
    "old_vehicle.type": "报废车辆类型",
    "old_vehicle.recycle_date": "报废交车日期",
    "scrap_certificate.certificate_no": "报废证明编号",
    "application.dealer_name": "经销商",
    "old_vehicle.vin": "报废车辆车架号",
    "old_vehicle.plate_no": "报废车辆车牌号",
    "old_vehicle.engine_model": "报废发动机型号",
    "old_vehicle.owner": "报废车辆所有人",
    "new_vehicle.fuel_type": "新车燃料类型",
    "invoice.code": "发票代码",
    "invoice.invoice_no": "发票号码",
    "invoice.invoice_date": "开票日期",
    "invoice.amount": "开票金额",
    "new_vehicle.vin": "新车车架号",
    "page_ocr.new_vehicle_vin": "OCR新车车架号",
    "new_vehicle.plate_no": "新车车牌号",
    "new_vehicle.owner": "新车所有人",
    "new_vehicle.registration_date": "注册日期",
    "application.terminal_certificate_no": "终端证件号",
    "application.customer_name": "客户名称",
    "application.terminal_phone": "终端客户手机号",
    "old_vehicle.affiliation": "报废车挂靠",
    "new_vehicle.affiliation": "新车挂靠",
}

# 客户名称由主体关系规则取得材料侧候选，同时仍须作为页面字段独立展示。
SCRAP_FIELD_BY_AFFILIATION_CHECK_ID = {
    "AFFILIATION-AUX-CUSTOMER-NAME": "application.customer_name",
}

TRANSFER_REVIEW_FIELDS = (
    "transfer.plate_no",
    "transfer.vin",
    "transfer.buyer_name",
    "transfer.seller_name",
    "transfer.invoice_date",
)
