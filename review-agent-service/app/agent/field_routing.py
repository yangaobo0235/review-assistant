"""模型提取字段到审核领域字段的安全路由。

页面提供的业务分区决定旧车、新车或过户归属；模型只负责识别材料类型和字段值，
不得自行改变材料所属业务范围。
"""

from collections.abc import Mapping
from typing import Any

# 只有这三个车辆通用字段可在旧车与新车命名空间之间按页面范围路由。
VEHICLE_FIELDS = {"vin", "plate_no", "owner", "type", "registration_date", "fuel_type"}
# 兼容旧版前端把业务角色当作文档类型提交的请求。
LEGACY_DOCUMENT_TYPES = {
    "old_vehicle": "vehicle_license",
    "new_vehicle": "vehicle_license",
    "id_card": "identity_card",
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
    if normalized_type == "identity_card":
        allowed = {"identity_card.name", "identity_card.side"}
        return {
            field: value
            for field, value in fields.items()
            if field in allowed and value not in (None, "", [], {})
        }, None
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
    routed: dict[str, Any] = {}
    for field_name, value in fields.items():
        if not value:
            continue
        if normalized_type == "registration_certificate":
            if field_name == "vehicle.vin":
                suffix = field_name.removeprefix("vehicle.")
                routed[f"{business_scope}.{suffix}"] = value
            elif business_scope == "old_vehicle" and field_name in {
                "vehicle.engine_model",
                "old_vehicle.engine_model",
            }:
                routed["old_vehicle.engine_model"] = value
            elif field_name in {"vehicle.type", "vehicle.fuel_type", "vehicle.registration_date"}:
                target = {
                    "vehicle.type": f"{business_scope}.type",
                    "vehicle.fuel_type": f"{business_scope}.fuel_type",
                    "vehicle.registration_date": f"{business_scope}.registration_date",
                }[field_name]
                routed[target] = value
            continue
        if normalized_type == "invoice" and business_scope == "new_vehicle" and field_name == "vehicle.owner":
            # 发票购买方名称同时支撑新车所有人和客户名称，避免客户名称因没有独立 OCR 键而被判信息不足。
            routed["new_vehicle.owner"] = value
            routed["application.customer_name"] = value
            continue
        suffix = _vehicle_suffix(field_name)
        if suffix is not None:
            routed[f"{business_scope}.{suffix}"] = value
            continue
        is_allowed_passthrough = (
            normalized_type == "scrap_certificate"
            and field_name in {"old_vehicle.recycle_date", "vehicle.type"}
        ) or (
            normalized_type == "scrap_certificate"
            and field_name == "scrap_certificate.certificate_no"
        ) or (
            normalized_type == "invoice"
            and field_name in {
                "invoice.invoice_no",
                "invoice.amount",
                "invoice.invoice_date",
                "new_vehicle.origin",
                "invoice.terminal_certificate_no",
                "invoice.phone",
            }
        )
        if is_allowed_passthrough:
            target_field = {
                "invoice.terminal_certificate_no": "application.terminal_certificate_no",
                "invoice.phone": "application.terminal_phone",
            }.get(field_name, field_name)
            routed[target_field] = value
    if normalized_type == "invoice" and business_scope == "new_vehicle":
        # 数电机动车销售发票票面只有一个“数电号码”。模型只提取一次，
        # 页面“发票代码”由确定性兼容层派生，避免模型分别生成两个可能冲突的值。
        invoice_number = routed.get("invoice.invoice_no")
        if invoice_number not in (None, "", [], {}):
            routed["invoice.code"] = invoice_number
    return routed, None
