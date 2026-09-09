"""业务审核配置。

主要职责：定义不同业务、地区和版本的字段与规则开关。
修改日期：2026-08-26
修改人：wuyi
"""

from dataclasses import dataclass

from app.businesses.material_policies import (
    DEFAULT_RETRY_POLICY,
    SCRAP_REPLACEMENT_MATERIAL_POLICY,
    TRANSFER_MATERIAL_POLICY,
    MaterialPolicy,
    RetryPolicy,
)
from app.models.review import BusinessType, Region
from app.rules.review_fields import (
    NEW_VEHICLE_AND_INVOICE_FIELDS,
    OLD_VEHICLE_FIELDS,
    PRIMARY_REVIEW_FIELDS,
    TRANSFER_REVIEW_FIELDS,
)


@dataclass(frozen=True)
class SectionDefinition:
    id: str
    title: str
    fields: tuple[str, ...]


@dataclass(frozen=True)
class BusinessProfile:
    business_type: BusinessType
    region: Region
    version: str
    required_fields: tuple[str, ...]
    sections: tuple[SectionDefinition, ...]
    rules_configured: bool
    qr_required: bool = False
    unconfigured_message: str | None = None
    material_policy: MaterialPolicy | None = None
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY


SCRAP_REPLACEMENT_QINGDAO = BusinessProfile(
    business_type=BusinessType.SCRAP_REPLACEMENT,
    region=Region.QINGDAO,
    version="1.0",
    required_fields=PRIMARY_REVIEW_FIELDS,
    sections=(
        SectionDefinition("old_vehicle", "报废车辆信息", OLD_VEHICLE_FIELDS),
        SectionDefinition(
            "new_vehicle",
            "新车及发票信息",
            NEW_VEHICLE_AND_INVOICE_FIELDS,
        ),
    ),
    rules_configured=True,
    qr_required=True,
    material_policy=SCRAP_REPLACEMENT_MATERIAL_POLICY,
)

VEHICLE_SOURCE_DEFAULT = BusinessProfile(
    business_type=BusinessType.VEHICLE_SOURCE,
    region=Region.DEFAULT,
    version="1.0",
    required_fields=(),
    sections=(),
    rules_configured=False,
    unconfigured_message="车源审核规则尚未配置，请人工复核",
)

TRANSFER_DEFAULT = BusinessProfile(
    business_type=BusinessType.TRANSFER,
    region=Region.DEFAULT,
    version="1.0",
    required_fields=TRANSFER_REVIEW_FIELDS,
    sections=(SectionDefinition("transfer", "过户凭证信息", TRANSFER_REVIEW_FIELDS),),
    rules_configured=True,
    qr_required=False,
    material_policy=TRANSFER_MATERIAL_POLICY,
)

CONSISTENCY_QINGDAO = BusinessProfile(
    business_type=BusinessType.CONSISTENCY,
    region=Region.QINGDAO,
    version="1.0",
    required_fields=(),
    sections=(),
    rules_configured=False,
    unconfigured_message="一致性审核规则尚未配置，请人工复核",
)

BUSINESS_PROFILES = (
    SCRAP_REPLACEMENT_QINGDAO,
    VEHICLE_SOURCE_DEFAULT,
    TRANSFER_DEFAULT,
    CONSISTENCY_QINGDAO,
)
