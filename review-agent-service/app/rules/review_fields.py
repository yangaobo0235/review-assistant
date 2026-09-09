"""报废置换审核的主要字段清单及展示名称。"""

OLD_VEHICLE_FIELDS = (
    "old_vehicle.recycle_date",
    "old_vehicle.vin",
    "old_vehicle.plate_no",
    "old_vehicle.owner",
    "old_vehicle.engine_model",
)

NEW_VEHICLE_AND_INVOICE_FIELDS = (
    "invoice.code",
    "invoice.amount",
    "invoice.invoice_date",
    "new_vehicle.vin",
    "new_vehicle.plate_no",
    "new_vehicle.owner",
)

PRIMARY_REVIEW_FIELDS = OLD_VEHICLE_FIELDS + NEW_VEHICLE_AND_INVOICE_FIELDS

TRANSFER_REVIEW_FIELDS = (
    "transfer.plate_no",
    "transfer.vin",
    "transfer.buyer_name",
    "transfer.seller_name",
    "transfer.invoice_date",
)
