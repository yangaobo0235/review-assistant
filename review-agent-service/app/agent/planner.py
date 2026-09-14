"""根据 Profile 生成能力执行计划。"""

from dataclasses import dataclass
from typing import Literal

from app.businesses.profiles import BusinessProfile

CapabilityStatus = Literal["READY", "SKIPPED", "BLOCKED", "NOT_CONFIGURED"]


@dataclass(frozen=True)
class CapabilityPlanItem:
    capability_id: str
    status: CapabilityStatus
    reason: str = ""


def plan_capabilities(profile: BusinessProfile) -> tuple[CapabilityPlanItem, ...]:
    """只规划 Profile 声明的能力；未配置业务不会隐式执行能力。"""
    if not profile.rules_configured:
        return (CapabilityPlanItem("profile", "NOT_CONFIGURED", profile.unconfigured_message or "业务规则未配置"),)
    items = [CapabilityPlanItem(spec.check_id, "READY") for spec in profile.external_checks]
    items.extend(CapabilityPlanItem(group, "READY") for group in profile.rule_groups)
    return tuple(items)
