"""业务审核配置。

主要职责：定义不同业务、地区和版本的字段与规则开关。
修改日期：2026-08-26
修改人：wuyi
"""

from dataclasses import dataclass, replace

from app.businesses.material_policies import (
    DEFAULT_RETRY_POLICY,
    SCRAP_REPLACEMENT_MATERIAL_POLICY,
    MaterialPolicy,
    RetryPolicy,
)
from app.businesses.replacement_policies import (
    CHANGCHUN_REPLACEMENT_POLICY,
    QINGDAO_REPLACEMENT_POLICY,
    ReplacementPolicy,
)
from app.models.review import BusinessType, Region
from app.rules.capabilities import CapabilityBinding, CapabilitySpec, ExternalCheckSpec
from app.rules.review_fields import (
    NEW_VEHICLE_AND_INVOICE_FIELDS,
    OLD_VEHICLE_FIELDS,
    PRIMARY_REVIEW_FIELDS,
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
    unconfigured_message: str | None = None
    material_policy: MaterialPolicy | None = None
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY
    external_checks: tuple[ExternalCheckSpec, ...] = ()
    rule_groups: tuple[str, ...] = ()
    page_actions: tuple[str, ...] = ()
    page_action_ids: tuple[str, ...] = ()
    replacement_policy: ReplacementPolicy | None = None
    capability_specs: tuple[CapabilitySpec, ...] = ()
    binding_declarations: tuple[CapabilityBinding, ...] = ()
    page_interaction: bool = False

    @property
    def capabilities(self) -> tuple[CapabilitySpec, ...]:
        # New profiles may declare their complete capability set directly via
        # ``capability_specs``/bindings without using the legacy selector
        # fields. Accept that shape as the canonical form.
        if self.capability_specs and not self.external_checks and not self.rule_groups:
            specs = list(self.capability_specs)
            if self.material_policy and not any(
                spec.capability_id == "material_completeness" for spec in specs
            ):
                specs.append(CapabilitySpec("material_completeness", kind="MATERIAL", stage="INPUT_COVERAGE"))
            return tuple(specs)
        templates = {spec.capability_id: spec for spec in self.capability_specs}
        specs: list[CapabilitySpec] = []
        for external in self.external_checks:
            template = templates.get(external.check_id, CapabilitySpec(
                external.check_id,
                kind="EXTERNAL",
                stage="EVIDENCE",
                dependencies=("old_vehicle",),
                timeout_seconds=60,
            ))
            specs.append(replace(
                template,
                capability_id=external.check_id,
                kind="EXTERNAL",
                required=external.mode == "REQUIRED",
                stage="EVIDENCE",
            ))
        for group in self.rule_groups:
            template = templates.get(group, CapabilitySpec(
                group,
                kind="RULE",
                stage="FINAL_REVIEW" if group == "affiliation_subject" else "POST_COMPARE",
            ))
            specs.append(replace(
                template,
                capability_id=group,
                kind="RULE",
                stage="FINAL_REVIEW" if group == "affiliation_subject" else template.stage,
            ))
        if self.material_policy:
            template = templates.get("material_completeness", CapabilitySpec(
                "material_completeness", kind="MATERIAL", stage="INPUT_COVERAGE"
            ))
            specs.append(replace(
                template,
                capability_id="material_completeness",
                kind="MATERIAL",
                stage="INPUT_COVERAGE",
            ))
        return tuple(specs)

    @property
    def capability_bindings(self) -> tuple[CapabilityBinding, ...]:
        """Stable declarative view consumed by planners and tooling."""
        return tuple(
            CapabilityBinding(spec.capability_id, enabled=True, required=spec.required)
            for spec in self.capabilities
        )

    @property
    def bindings(self) -> tuple[CapabilityBinding, ...]:
        """Canonical capability declarations exposed to the planner.

        The legacy ``external_checks``/``rule_groups`` fields are still
        accepted at the profile boundary for migration, but application code
        should consume this stable binding view.
        """
        generated = self.capability_bindings
        if not self.binding_declarations:
            return generated
        generated_map = {item.capability_id: item for item in generated}
        declared_map = {item.capability_id: item for item in self.binding_declarations}
        # A dataclasses.replace() call that changes legacy fields must remain
        # effective during migration (for example REQUIRED → WHEN_PRESENT).
        # In that case fall back to the regenerated view instead of retaining
        # stale declarations.
        if set(generated_map) != set(declared_map):
            return generated
        if any(
            declared.required is not None
            and generated_map[key].required != declared.required
            for key, declared in declared_map.items()
        ):
            return generated
        return self.binding_declarations

    @property
    def enabled_page_actions(self) -> tuple[str, ...]:
        """Canonical page action ids declared by this profile.

        ``page_actions`` remains a boundary-only compatibility field for
        historical profile constructors.
        """
        return self.page_action_ids or self.page_actions





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
    material_policy=SCRAP_REPLACEMENT_MATERIAL_POLICY,
    page_action_ids=("fill_affiliation_fields",),
    replacement_policy=QINGDAO_REPLACEMENT_POLICY,
    binding_declarations=(
        CapabilityBinding("material_completeness"),
        CapabilityBinding("scrap_certificate_qr", required=True),
        CapabilityBinding("qingdao_replacement_policy"),
        CapabilityBinding("affiliation_subject"),
    ),
    page_interaction=True,
    capability_specs=(
        CapabilitySpec(
            "material_completeness", kind="MATERIAL", stage="INPUT_COVERAGE",
            output_facts=("material.coverage",), failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "scrap_certificate_qr", kind="EXTERNAL", stage="EVIDENCE",
            required=True, dependencies=("old_vehicle",), timeout_seconds=60,
            output_facts=("qr.valid", "scrap_certificate.verified"),
            failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "qingdao_replacement_policy", kind="RULE", stage="POST_COMPARE",
            output_facts=("replacement.eligible",), failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "affiliation_subject", kind="RULE", stage="FINAL_REVIEW",
            output_facts=("subject.relation",), failure_policy="MANUAL_REVIEW",
        ),
    ),
)

VEHICLE_SOURCE_DEFAULT = BusinessProfile(
    business_type=BusinessType.VEHICLE_SOURCE,
    region=Region.DEFAULT,
    version="1.0",
    required_fields=(),
    sections=(),
    rules_configured=False,
    unconfigured_message="车源审核规则尚未配置，请人工复核",
    external_checks=(),
    rule_groups=(),
    page_actions=(),
)

CONSISTENCY_QINGDAO = BusinessProfile(
    business_type=BusinessType.CONSISTENCY,
    region=Region.QINGDAO,
    version="1.0",
    required_fields=(),
    sections=(),
    rules_configured=False,
    unconfigured_message="一致性审核规则尚未配置，请人工复核",
    external_checks=(),
    rule_groups=(),
    page_actions=(),
)

SCRAP_REPLACEMENT_CHANGCHUN = BusinessProfile(
    business_type=BusinessType.SCRAP_REPLACEMENT,
    region=Region.CHANGCHUN,
    version="1.0",
    required_fields=PRIMARY_REVIEW_FIELDS,
    sections=(
        SectionDefinition("old_vehicle", "报废车辆信息", OLD_VEHICLE_FIELDS),
        SectionDefinition(
            "new_vehicle", "新车及发票信息", NEW_VEHICLE_AND_INVOICE_FIELDS
        ),
    ),
    rules_configured=True,
    material_policy=SCRAP_REPLACEMENT_MATERIAL_POLICY,
    page_action_ids=("fill_affiliation_fields",),
    replacement_policy=CHANGCHUN_REPLACEMENT_POLICY,
    binding_declarations=(
        CapabilityBinding("material_completeness"),
        CapabilityBinding("scrap_certificate_qr", required=True),
        CapabilityBinding("changchun_replacement_policy"),
        CapabilityBinding("affiliation_subject"),
    ),
    page_interaction=True,
    capability_specs=(
        CapabilitySpec(
            "material_completeness", kind="MATERIAL", stage="INPUT_COVERAGE",
            output_facts=("material.coverage",), failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "scrap_certificate_qr", kind="EXTERNAL", stage="EVIDENCE",
            required=True, dependencies=("old_vehicle",), timeout_seconds=60,
            output_facts=("qr.valid", "scrap_certificate.verified"),
            failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "changchun_replacement_policy", kind="RULE", stage="POST_COMPARE",
            output_facts=("replacement.eligible",), failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "affiliation_subject", kind="RULE", stage="FINAL_REVIEW",
            output_facts=("subject.relation",), failure_policy="MANUAL_REVIEW",
        ),
    ),
)

# 仅用于旧数据/测试迁移，永不加入 BUSINESS_PROFILES。
TRANSFER_DEFAULT = BusinessProfile(
    business_type=BusinessType.TRANSFER,
    region=Region.DEFAULT,
    version="deprecated",
    required_fields=(),
    sections=(),
    rules_configured=False,
    unconfigured_message="过户审核已停用",
)

CONSISTENCY_CHANGCHUN = BusinessProfile(
    business_type=BusinessType.CONSISTENCY,
    region=Region.CHANGCHUN,
    version="1.0",
    required_fields=(),
    sections=(),
    rules_configured=False,
    unconfigured_message="长春一致性审核规则尚未配置，请人工复核",
)

BUSINESS_PROFILES = (
    SCRAP_REPLACEMENT_QINGDAO,
    SCRAP_REPLACEMENT_CHANGCHUN,
    VEHICLE_SOURCE_DEFAULT,
    CONSISTENCY_QINGDAO,
    CONSISTENCY_CHANGCHUN,
)
