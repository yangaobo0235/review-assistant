"""报废置换字段的动态证据来源策略。

策略只描述允许的来源和比较语义，不把某一张材料当成所有申请都必须存在的
“主要来源”。运行时仍以实际识别到的有效证据为准。
"""

from dataclasses import dataclass, replace
from typing import Literal

EvidenceMode = Literal[
    "SYSTEM", "SINGLE_SOURCE", "AVAILABLE_EVIDENCE", "PARALLEL", "PAGE_AUXILIARY", "DERIVED"
]


@dataclass(frozen=True)
class FieldEvidencePolicy:
    field: str
    mode: EvidenceMode
    allowed_document_types: tuple[str, ...] = ()
    preferred_document_types: tuple[str, ...] = ()
    allow_single_evidence: bool = True
    missing_behavior: Literal["NOT_FOUND", "DERIVED", "SYSTEM"] = "NOT_FOUND"
    normalizer: str = "default"


def _p(field: str, mode: EvidenceMode, allowed: tuple[str, ...] = (), preferred: tuple[str, ...] = (), *, single: bool = True, missing: Literal["NOT_FOUND", "DERIVED", "SYSTEM"] = "NOT_FOUND", normalizer: str = "default") -> FieldEvidencePolicy:
    return FieldEvidencePolicy(field, mode, allowed, preferred, single, missing, normalizer)


FIELD_EVIDENCE_POLICIES: dict[str, FieldEvidencePolicy] = {
    "application.owner_type": _p("application.owner_type", "SYSTEM", missing="SYSTEM"),
    "old_vehicle.type": _p("old_vehicle.type", "PARALLEL", ("vehicle_license", "registration_certificate", "scrap_certificate"), normalizer="vehicle_type"),
    "old_vehicle.recycle_date": _p("old_vehicle.recycle_date", "SINGLE_SOURCE", ("scrap_certificate",), normalizer="date"),
    "scrap_certificate.certificate_no": _p("scrap_certificate.certificate_no", "SINGLE_SOURCE", ("scrap_certificate",)),
    "old_vehicle.vin": _p("old_vehicle.vin", "PARALLEL", ("vehicle_license", "registration_certificate", "scrap_certificate"), normalizer="vin"),
    "old_vehicle.plate_no": _p("old_vehicle.plate_no", "SINGLE_SOURCE", ("vehicle_license",), ("vehicle_license",), normalizer="plate"),
    "old_vehicle.engine_model": _p("old_vehicle.engine_model", "SINGLE_SOURCE", ("registration_certificate",), ("registration_certificate",)),
    "old_vehicle.owner": _p("old_vehicle.owner", "PARALLEL", ("vehicle_license", "scrap_certificate"), normalizer="party_name"),
    "new_vehicle.fuel_type": _p("new_vehicle.fuel_type", "SINGLE_SOURCE", ("registration_certificate",), ("registration_certificate",)),
    "invoice.code": _p("invoice.code", "SINGLE_SOURCE", ("invoice",)),
    "invoice.invoice_no": _p("invoice.invoice_no", "SINGLE_SOURCE", ("invoice",)),
    "invoice.amount": _p("invoice.amount", "SINGLE_SOURCE", ("invoice",), normalizer="amount"),
    "invoice.invoice_date": _p("invoice.invoice_date", "SINGLE_SOURCE", ("invoice",), normalizer="date"),
    "new_vehicle.vin": _p("new_vehicle.vin", "PARALLEL", ("vehicle_license", "registration_certificate", "invoice"), normalizer="vin"),
    "new_vehicle.plate_no": _p("new_vehicle.plate_no", "SINGLE_SOURCE", ("vehicle_license",), normalizer="plate"),
    "new_vehicle.owner": _p("new_vehicle.owner", "PARALLEL", ("vehicle_license", "invoice"), normalizer="party_name"),
    "new_vehicle.registration_date": _p("new_vehicle.registration_date", "SINGLE_SOURCE", ("vehicle_license",), ("vehicle_license",), normalizer="date"),
    "application.terminal_certificate_no": _p("application.terminal_certificate_no", "SINGLE_SOURCE", ("invoice",)),
    "application.customer_name": _p("application.customer_name", "SINGLE_SOURCE", ("invoice",), normalizer="party_name"),
    "application.terminal_phone": _p("application.terminal_phone", "SINGLE_SOURCE", ("invoice",)),
    "old_vehicle.affiliation": _p("old_vehicle.affiliation", "DERIVED", missing="DERIVED"),
    "new_vehicle.affiliation": _p("new_vehicle.affiliation", "DERIVED", missing="DERIVED"),
}


# Separate page controls can compare against the same material field.
MATERIAL_FIELD_BY_PAGE_FIELD = {"page_ocr.new_vehicle_vin": "new_vehicle.vin"}
FIELD_EVIDENCE_POLICIES.update({
    page_field: replace(FIELD_EVIDENCE_POLICIES[material_field], field=page_field)
    for page_field, material_field in MATERIAL_FIELD_BY_PAGE_FIELD.items()
})


def field_policy(field: str) -> FieldEvidencePolicy | None:
    return FIELD_EVIDENCE_POLICIES.get(field)


def is_scrap_field(field: str) -> bool:
    return field in FIELD_EVIDENCE_POLICIES


def filter_allowed_observations(field: str, observations):
    """按实际材料类型过滤证据；未知类型不冒充允许来源。"""
    policy = field_policy(field)
    if policy is None or policy.mode in {"SYSTEM", "DERIVED", "PAGE_AUXILIARY"}:
        return list(observations)
    allowed = set(policy.allowed_document_types)
    result = []
    for item in observations:
        if item.source_type == "page" or item.source_type in {"image", "qr_page"} and (not item.document_type or item.document_type in allowed):
            result.append(item)
    return result
