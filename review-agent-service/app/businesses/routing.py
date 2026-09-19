"""模型提取字段到审核领域字段的安全路由。

页面提供的业务分区决定旧车或新车归属；模型只负责识别材料类型和字段值，
不得自行改变材料所属业务范围。
"""

from collections.abc import Mapping
from typing import Any

from app.businesses.packs import SCRAP_REPLACEMENT_PACK as _PACK
from app.businesses.packs.model import BusinessExtensionPack, MaterialDeclaration

# 材料上的车辆通用字段可能写作这三种前缀之一，落到哪个分区由页面决定。
VEHICLE_PREFIXES = {"vehicle", "old_vehicle", "new_vehicle"}
# 兼容旧版前端把业务角色当作文档类型提交的请求。
LEGACY_DOCUMENT_TYPES = {
    "old_vehicle": "vehicle_license",
    "new_vehicle": "vehicle_license",
    "id_card": "identity_card",
}


def normalize_document_type(document_type: str) -> str:
    """把旧版车辆角色名称归一为实际材料类型。"""
    return LEGACY_DOCUMENT_TYPES.get(document_type, document_type)


def _vehicle_suffix(material: MaterialDeclaration | None, field_name: str) -> str | None:
    """返回该材料上跟随页面分区落位的车辆字段后缀。"""
    if material is None:
        return None
    prefix, separator, suffix = field_name.partition(".")
    if (
        separator
        and prefix in VEHICLE_PREFIXES
        and suffix in set(material.scoped_vehicle_fields)
    ):
        return suffix
    return None


def route_fields(
    business_scope: str,
    document_type: str,
    fields: Mapping[str, Any],
    pack: BusinessExtensionPack | None = None,
) -> tuple[dict[str, Any], str | None]:
    """按页面确定的业务范围路由字段，并返回需要人工复核的限制说明。

    分区白名单、材料归属和字段映射都来自业务声明（`app.businesses.packs`）；
    新增业务时只要在声明里写清这些内容，本函数不需要改动。
    """
    resolved_pack = pack or _PACK
    normalized_type = normalize_document_type(document_type)
    material = resolved_pack.material(normalized_type)

    # 营业执照、身份证这类材料不属于业务分区，字段按材料自身白名单原样通过。
    if material is not None and material.scope_independent:
        allowed = set(material.fields)
        return {
            field: value
            for field, value in fields.items()
            if field in allowed and value not in (None, "", [], {})
        }, None

    if business_scope not in resolved_pack.scopes:
        return {}, "图片业务归属无法确定，请人工复核"
    # 材料类型与页面分区矛盾时拒绝路由，不能让模型识别结果覆盖页面业务归属。
    if (
        material is not None
        and material.allowed_scopes
        and business_scope not in material.allowed_scopes
    ):
        return {}, f"{material.display_name}位于不属于它的资料区域，请人工复核"

    routes = [
        rule
        for rule in resolved_pack.routes
        if rule.document_type == normalized_type
        and (not rule.scope or rule.scope == business_scope)
    ]

    routed: dict[str, Any] = {}
    for field_name, value in fields.items():
        if not value:
            continue
        matched = False
        for rule in routes:
            if rule.source_field != field_name:
                continue
            for target in rule.targets:
                routed[target.replace("{scope}", business_scope)] = value
            matched = True
            break
        if matched:
            continue
        suffix = _vehicle_suffix(material, field_name)
        if suffix is not None:
            routed[f"{business_scope}.{suffix}"] = value

    if normalized_type == "invoice" and "invoice.invoice_no" in routed:
        # 数电机动车销售发票票面只有一个“数电号码”。模型只提取一次，
        # 页面“发票代码”由确定性兼容层派生，避免模型分别生成两个可能冲突的值。
        routed["invoice.code"] = routed["invoice.invoice_no"]
    return routed, None
