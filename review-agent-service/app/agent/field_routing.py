"""模型提取字段到审核领域字段的安全路由。

页面提供的业务分区决定旧车、新车或过户归属；模型只负责识别材料类型和字段值，
不得自行改变材料所属业务范围。
"""

from collections.abc import Mapping
from typing import Any

# 只有这三个车辆通用字段可在旧车与新车命名空间之间按页面范围路由。
VEHICLE_FIELDS = {"vin", "plate_no", "owner"}
# 兼容旧版前端把业务角色当作文档类型提交的请求。
LEGACY_DOCUMENT_TYPES = {
    "old_vehicle": "vehicle_license",
    "new_vehicle": "vehicle_license",
}


def normalize_document_type(document_type: str) -> str:
    """把旧版车辆角色名称归一为实际材料类型。"""
    return LEGACY_DOCUMENT_TYPES.get(document_type, document_type)


def _vehicle_suffix(field_name: str) -> str | None:
    """返回允许跨业务范围路由的车辆字段后缀。"""
    prefix, separator, suffix = field_name.partition(".")
    if separator and prefix in {"vehicle", "old_vehicle", "new_vehicle"} and suffix in VEHICLE_FIELDS:
        return suffix
    return None


def route_fields(
    business_scope: str,
    document_type: str,
    fields: Mapping[str, Any],
) -> tuple[dict[str, Any], str | None]:
    """按页面确定的业务范围路由字段，并返回需要人工复核的限制说明。"""
    normalized_type = normalize_document_type(document_type)
    if normalized_type == "business_license":
        allowed = {
            "business_license.company_name",
            "business_license.legal_representative",
            "business_license.unified_social_credit_code",
        }
        return {
            field: value
            for field, value in fields.items()
            if field in allowed and value not in (None, "", [], {})
        }, None
    if business_scope == "transfer":
        # 过户材料使用独立命名空间，防止与报废置换的新旧车字段混合比较。
        if normalized_type == "invoice":
            mapping = {
                "vehicle.plate_no": "transfer.plate_no",
                "vehicle.vin": "transfer.vin",
                "invoice.buyer_name": "transfer.buyer_name",
                "invoice.seller_name": "transfer.seller_name",
                "invoice.invoice_date": "transfer.invoice_date",
            }
        elif normalized_type == "registration_certificate":
            mapping = {
                "vehicle.vin": "transfer.vin",
                "registration.covered_pages": "transfer.registration.covered_pages",
                "registration.initial_owner": "transfer.registration.initial_owner",
                "registration.transfer_records": "transfer.registration.transfer_records",
            }
        else:
            return {}, "过户资料仅支持机动车登记证书和二手车发票，请人工复核"
        routed_transfer: dict[str, Any] = {}
        for source, target in mapping.items():
            value = fields.get(source)
            if value in (None, "", [], {}):
                continue
            routed_transfer[target] = value
        return routed_transfer, None
    if business_scope not in {"old_vehicle", "new_vehicle"}:
        return {}, "图片业务归属无法确定，请人工复核"
    # 材料类型与页面分区矛盾时拒绝路由，不能让模型识别结果覆盖页面业务归属。
    if normalized_type == "scrap_certificate" and business_scope != "old_vehicle":
        return {}, "回收证明位于新车资料区域，请人工复核"
    if normalized_type == "invoice" and business_scope != "new_vehicle":
        return {}, "发票位于报废车辆资料区域，请人工复核"
    routed: dict[str, str] = {}
    for field_name, value in fields.items():
        if not value:
            continue
        if normalized_type == "registration_certificate":
            if field_name in {"vehicle.owner", "vehicle.vin"}:
                suffix = field_name.removeprefix("vehicle.")
                routed[f"{business_scope}.{suffix}"] = value
            elif business_scope == "old_vehicle" and field_name in {
                "vehicle.engine_model",
                "old_vehicle.engine_model",
            }:
                routed["old_vehicle.engine_model"] = value
            continue
        suffix = _vehicle_suffix(field_name)
        if suffix is not None:
            routed[f"{business_scope}.{suffix}"] = value
            continue
        is_allowed_passthrough = (
            normalized_type == "scrap_certificate"
            and field_name == "old_vehicle.recycle_date"
        ) or (
            normalized_type == "scrap_certificate"
            and field_name == "scrap_certificate.certificate_no"
        ) or (
            normalized_type == "invoice"
            and field_name in {
                "invoice.code",
                "invoice.invoice_no",
                "invoice.amount",
                "invoice.invoice_date",
                "new_vehicle.origin",
            }
        )
        if is_allowed_passthrough:
            routed[field_name] = value
    return routed, None
