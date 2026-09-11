"""旧车、新车主体类型及营业执照法人关系检查。"""

import re
from dataclasses import dataclass

from app.agent.models import ReviewCheck, ReviewCheckValue
from app.models.review import FieldObservation, PageFillAction
from app.rules.evidence_values import observation_evidence, readable_value
from app.rules.normalize import normalize_value

COMPANY_PATTERN = re.compile(
    r"(?:有限责任公司|股份有限公司|有限公司|公司|企业|合作社|经营部|厂)$"
)
PERSON_PATTERN = re.compile(r"^[\u3400-\u9fff]{2,4}$")


@dataclass(frozen=True)
class BusinessLicenseEvidence:
    source_id: str
    company_name: str | None
    legal_representative: str | None
    unified_social_credit_code: str | None
    ambiguous: bool = False
    company_names: tuple[str, ...] = ()


@dataclass(frozen=True)
class AffiliationCheckResult:
    check: ReviewCheck
    owner_types: tuple[str | None, str | None]
    page_actions: tuple[PageFillAction, ...] = ()


def _name(value: object | None) -> str | None:
    normalized = normalize_value("party.owner", value)
    return normalized if readable_value(normalized) else None


def _person_name(value: object | None) -> str | None:
    name = _name(value)
    return (
        name
        if name and PERSON_PATTERN.fullmatch(name) and not COMPANY_PATTERN.search(name)
        else None
    )


def group_business_licenses(
    observations: list[FieldObservation],
) -> list[BusinessLicenseEvidence]:
    grouped: dict[str, dict[str, set[str]]] = {}
    uncertain_sources: set[str] = set()
    for item in observations:
        if item.source_type != "image" or item.document_type != "business_license":
            continue
        if not item.field.startswith("business_license.") or item.value in (None, ""):
            continue
        if item.uncertain:
            uncertain_sources.add(item.source_id)
        grouped.setdefault(item.source_id, {}).setdefault(item.field, set()).add(
            str(item.value)
        )
    return [
        BusinessLicenseEvidence(
            source_id=source_id,
            company_name=next(
                iter(values.get("business_license.company_name", set())), None
            ),
            legal_representative=next(
                iter(values.get("business_license.legal_representative", set())), None
            ),
            unified_social_credit_code=next(
                iter(values.get("business_license.unified_social_credit_code", set())),
                None,
            ),
            ambiguous=source_id in uncertain_sources
            or any(len(field_values) > 1 for field_values in values.values()),
            company_names=tuple(
                sorted(values.get("business_license.company_name", set()))
            ),
        )
        for source_id, values in grouped.items()
    ]


def _license_for(
    owner: str, licenses: list[BusinessLicenseEvidence]
) -> BusinessLicenseEvidence | None:
    matches = [
        item
        for item in licenses
        if owner in {_name(name) for name in item.company_names or (item.company_name,)}
    ]
    return matches[0] if len(matches) == 1 and not matches[0].ambiguous else None


def classify_owner_type(
    owner: object | None,
    licenses: list[BusinessLicenseEvidence],
) -> str | None:
    normalized = _name(owner)
    if not normalized:
        return None
    if _license_for(normalized, licenses) is not None or COMPANY_PATTERN.search(
        normalized
    ):
        return "COMPANY"
    if PERSON_PATTERN.fullmatch(normalized):
        return "PERSONAL"
    return None


def _action(field: str, label: str, owner_type: str) -> PageFillAction:
    return PageFillAction(field=field, target_label=label, owner_type=owner_type)


def _auxiliary_check(
    check_id: str,
    label: str,
    page_value: object | None,
    material_value: object | None,
    *,
    field: str,
    page_source: str,
    material_source: str,
) -> ReviewCheck:
    values = [
        ReviewCheckValue(source=page_source, value=page_value),
        ReviewCheckValue(source=material_source, value=material_value),
    ]
    normalized_page = normalize_value(field, page_value)
    normalized_material = normalize_value(field, material_value)
    if not normalized_page or not normalized_material:
        return ReviewCheck(
            check_id=check_id,
            label=label,
            status="INSUFFICIENT",
            reason="页面或材料未取得可比较的明确值",
            values=values,
        )
    return ReviewCheck(
        check_id=check_id,
        label=label,
        status="MATCH" if normalized_page == normalized_material else "CONFLICT",
        reason=(
            "页面字段与材料识别结果一致"
            if normalized_page == normalized_material
            else "页面字段与材料识别结果不一致"
        ),
        values=values,
    )


def normalize_page_owner_type(value: object | None) -> str | None:
    """Only recognize the page's explicit personal/company option labels."""

    normalized = normalize_value("application.owner_type", value)
    if normalized == "个人":
        return "PERSONAL"
    if normalized in {"公司", "企业"}:
        return "COMPANY"
    return None


def build_affiliation_auxiliary_checks(
    *,
    page_fields: dict[str, object],
    new_owner_type: str | None,
    new_vehicle_vin: object | None,
    new_owner: object | None,
) -> tuple[ReviewCheck, ...]:
    """Compare the three page safeguards without guessing labels or identities."""

    raw_page_owner_type = page_fields.get("application.owner_type")
    page_owner_type = normalize_page_owner_type(raw_page_owner_type)
    owner_type = _auxiliary_check(
        "AFFILIATION-AUX-OWNER-TYPE",
        "车辆所有人类型",
        page_owner_type,
        new_owner_type,
        field="application.owner_type",
        page_source="申请页面车辆所有人类型",
        material_source="新车主体类型",
    ).model_copy(
        update={
            "values": [
                ReviewCheckValue(
                    source="申请页面车辆所有人类型", value=raw_page_owner_type
                ),
                ReviewCheckValue(source="新车主体类型", value=new_owner_type),
            ]
        }
    )
    vin = _auxiliary_check(
        "AFFILIATION-AUX-NEW-VIN",
        "OCR新车车架号",
        page_fields.get("page_ocr.new_vehicle_vin"),
        new_vehicle_vin,
        field="new_vehicle.vin",
        page_source="页面OCR新车车架号",
        material_source="新车材料车架号",
    )
    customer = _auxiliary_check(
        "AFFILIATION-AUX-CUSTOMER-NAME",
        "客户名称",
        page_fields.get("application.customer_name"),
        new_owner,
        field="new_vehicle.owner",
        page_source="申请页面客户名称",
        material_source="新车材料所有人",
    )
    return owner_type, vin, customer


def build_affiliation_subject_check(
    old_owner: object | None,
    new_owner: object | None,
    observations: list[FieldObservation],
) -> AffiliationCheckResult:
    licenses = group_business_licenses(observations)
    old_name = _name(old_owner)
    new_name = _name(new_owner)
    old_type = classify_owner_type(old_owner, licenses)
    new_type = classify_owner_type(new_owner, licenses)
    values = [
        ReviewCheckValue(source="旧车所有人", value=old_owner),
        ReviewCheckValue(source="新车所有人", value=new_owner),
        ReviewCheckValue(source="旧车主体类型", value=old_type),
        ReviewCheckValue(source="新车主体类型", value=new_type),
    ]
    relevant_sources = {
        item.source_id
        for item in observations
        if item.field == "business_license.company_name"
        and _name(item.value) in {old_name, new_name}
    }
    evidence = observation_evidence(
        [
            item
            for item in observations
            if item.field in {"old_vehicle.owner", "new_vehicle.owner"}
            or item.source_id in relevant_sources
            and item.field
            in {
                "business_license.company_name",
                "business_license.legal_representative",
                "business_license.unified_social_credit_code",
            }
        ]
    )
    status = "INSUFFICIENT"
    reason = "旧车或新车主体类型无法可靠判断"

    related_licenses = [
        item
        for item in licenses
        if {_name(name) for name in item.company_names or (item.company_name,)}
        & {old_name, new_name}
    ]
    invalid_license_evidence = any(
        item.ambiguous or not _person_name(item.legal_representative)
        for item in related_licenses
    )
    company_names = {
        name
        for name, owner_type in ((old_name, old_type), (new_name, new_type))
        if owner_type == "COMPANY" and name
    }
    duplicate_license_evidence = any(
        sum(
            name
            in {
                _name(candidate)
                for candidate in item.company_names or (item.company_name,)
            }
            for item in related_licenses
        )
        > 1
        for name in company_names
    )

    if old_type == new_type == "COMPANY" and old_name and old_name == new_name:
        status = "MATCH"
        reason = "新旧车公司法定名称一致"
    elif invalid_license_evidence or duplicate_license_evidence:
        reason = "对应公司营业执照存在多份、冲突或不确定法人证据，请核对全部来源"
    elif old_type and new_type and old_name and new_name:
        if old_type == new_type == "PERSONAL":
            status = "MATCH" if old_name == new_name else "CONFLICT"
            reason = (
                "新旧车个人姓名一致"
                if status == "MATCH"
                else "新旧车均为个人但姓名不同"
            )
        elif old_type == new_type == "COMPANY":
            old_license = _license_for(old_name, licenses)
            new_license = _license_for(new_name, licenses)
            if (
                not old_license
                or not new_license
                or old_license.source_id == new_license.source_id
                or not _person_name(old_license.legal_representative)
                or not _person_name(new_license.legal_representative)
            ):
                reason = "缺少分别对应两家公司的完整营业执照法人证据"
            elif _name(old_license.legal_representative) == _name(
                new_license.legal_representative
            ):
                status = "MATCH"
                reason = "两家公司营业执照分别对应且法人相同"
            else:
                status = "CONFLICT"
                reason = "两家公司营业执照法人不同"
        else:
            company_name = old_name if old_type == "COMPANY" else new_name
            person_name = old_name if old_type == "PERSONAL" else new_name
            license_item = _license_for(company_name, licenses)
            if not license_item or not _person_name(license_item.legal_representative):
                reason = "缺少与公司对应的营业执照法人证据"
            elif _name(license_item.legal_representative) == person_name:
                status = "MATCH"
                reason = "公司营业执照法人等于个人姓名"
            else:
                status = "CONFLICT"
                reason = "公司营业执照法人与个人姓名不同"

    actions: tuple[PageFillAction, ...] = ()
    if status == "MATCH" and old_type and new_type:
        actions = (
            _action("old_vehicle.affiliation", "报废车挂靠", old_type),
            _action("new_vehicle.affiliation", "新车挂靠", new_type),
        )
    return AffiliationCheckResult(
        check=ReviewCheck(
            check_id="AFFILIATION-SUBJECT-001",
            label="新旧车挂靠主体关系",
            status=status,
            reason=reason,
            values=values,
            evidence=evidence,
        ),
        owner_types=(old_type, new_type),
        page_actions=actions,
    )
