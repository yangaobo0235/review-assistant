"""业务扩展包：一个审核业务的声明式描述。"""

from app.businesses.packs.model import (
    AuthorityRule,
    BusinessExtensionPack,
    EvidenceMode,
    FieldDeclaration,
    MaterialDeclaration,
    PageGroupDeclaration,
    RegionDeclaration,
    SectionDeclaration,
    build_collect_manifest,
)
from app.businesses.packs.scrap_replacement import SCRAP_REPLACEMENT_PACK
from app.models.review import BusinessType

# 业务类型 → 声明。同一业务的各地区共用一份声明，地区差异在 Profile 里。
BUSINESS_PACKS: dict[BusinessType, BusinessExtensionPack] = {
    BusinessType.SCRAP_REPLACEMENT: SCRAP_REPLACEMENT_PACK,
}


def pack_for_business(business_type: BusinessType) -> BusinessExtensionPack | None:
    """返回该业务的声明；尚未声明的业务返回 None。"""
    return BUSINESS_PACKS.get(business_type)


__all__ = [
    "BUSINESS_PACKS",
    "SCRAP_REPLACEMENT_PACK",
    "AuthorityRule",
    "BusinessExtensionPack",
    "EvidenceMode",
    "FieldDeclaration",
    "MaterialDeclaration",
    "PageGroupDeclaration",
    "RegionDeclaration",
    "SectionDeclaration",
    "build_collect_manifest",
    "pack_for_business",
]
