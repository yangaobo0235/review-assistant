import pytest
from pydantic import ValidationError

from app.agent.models import (
    MaterialCompletenessIssue,
    MaterialCompletenessReport,
    ReviewCheck,
)
from app.businesses.profiles import (
    SCRAP_REPLACEMENT_CHANGCHUN,
    SCRAP_REPLACEMENT_QINGDAO,
    TRANSFER_DEFAULT,
)
from app.models.review import (
    FieldComparison,
    FieldStatus,
    ReviewDisplayTarget,
    ReviewFieldSnapshot,
    ReviewRequest,
    ReviewStep,
)
from app.rules.review_step_routing import build_review_steps


def make_step(**changes) -> ReviewStep:
    values = {
        "step_id": "FIELD-new_vehicle.vin",
        "sequence": 1,
        "category": "FIELD",
        "display_target": ReviewDisplayTarget.PAGE_FIELD,
        "page_field": "new_vehicle.vin",
        "requires_reviewer_action": False,
        "label": "新车车架号",
        "result_status": "MATCH",
        "reason": "页面与材料一致",
    }
    values.update(changes)
    return ReviewStep(**values)


def test_page_field_target_requires_field_key() -> None:
    with pytest.raises(ValidationError):
        make_step(page_field=None)


def test_assistant_target_rejects_page_field_key() -> None:
    with pytest.raises(ValidationError):
        make_step(display_target="ASSISTANT", page_field="new_vehicle.vin")


def test_non_match_requires_reviewer_action() -> None:
    with pytest.raises(ValidationError):
        make_step(result_status="CONFLICT", requires_reviewer_action=False)


def test_matching_step_rejects_reviewer_action_requirement() -> None:
    with pytest.raises(ValidationError):
        make_step(result_status="MATCH", requires_reviewer_action=True)


def matching_comparison(field: str, value: str = "VIN-1") -> FieldComparison:
    return FieldComparison(
        field=field,
        left_value=value,
        right_value=value,
        status=FieldStatus.MATCH,
        message="页面与材料一致",
    )


def build_steps(
    *,
    page_fields: dict[str, str] | None = None,
    comparisons: list[FieldComparison] | None = None,
    external_checks: list[ReviewCheck] | None = None,
    business_checks: list[ReviewCheck] | None = None,
    completeness: MaterialCompletenessReport | None = None,
    limitations: list[str] | None = None,
    review_fields: list[ReviewFieldSnapshot] | None = None,
) -> list[ReviewStep]:
    return build_review_steps(
        request=ReviewRequest(
            page_url="https://admin.forjtruck.com/scrap-replace-qingdao/review/1",
            region="qingdao",
            page_fields=page_fields or {},
            review_fields=review_fields or [],
        ),
        profile=SCRAP_REPLACEMENT_QINGDAO,
        comparisons=comparisons or [],
        external_checks=external_checks or [],
        business_checks=business_checks or [],
        completeness=completeness,
        limitations=limitations or [],
    )


def test_present_comparison_routes_to_assistant_field() -> None:
    steps = build_steps(
        page_fields={"new_vehicle.vin": "VIN-1"},
        comparisons=[matching_comparison("new_vehicle.vin")],
    )

    step = next(item for item in steps if item.step_id == "FIELD-new_vehicle.vin")

    assert step.display_target is ReviewDisplayTarget.ASSISTANT
    assert step.page_field is None
    assert step.requires_reviewer_action is False


def test_field_step_counts_only_unique_material_images_as_evidence() -> None:
    comparison = FieldComparison(
        field="old_vehicle.type",
        left_value="重型半挂牵引车",
        right_value="牵引车",
        status=FieldStatus.MATCH,
        message="车辆类型属于同一业务大类",
        evidence=[
            {"source": "申请页面字段", "source_id": "page", "value": "牵引车"},
            {"source": "图片识别", "image_id": "old-license", "value": "重型半挂牵引车"},
            {"source": "图片识别", "image_id": "scrap-certificate", "value": "重型半挂牵引车"},
            {"source": "图片识别", "image_id": "old-registration", "value": "重型半挂牵引车"},
        ],
    )

    step = next(item for item in build_steps(
        page_fields={"old_vehicle.type": "牵引车"},
        comparisons=[comparison],
    ) if item.step_id == "FIELD-old_vehicle.type")

    assert step.evidence_count == 3
    assert len(step.evidence) == 3
    assert all(item.image_id for item in step.evidence)


def test_external_step_accepts_legacy_dict_evidence() -> None:
    steps = build_steps(
        external_checks=[
            ReviewCheck(
                check_id="EXTERNAL-QR",
                label="二维码官网核验",
                status="MATCH",
                reason="官网字段已提取",
                evidence=[{"source": "二维码官网字段", "value": {"vin": "VIN-1"}}],
            )
        ]
    )

    step = next(item for item in steps if item.step_id == "EXTERNAL-QR")
    assert step.evidence_sources == ["二维码官网字段"]


def test_missing_page_field_routes_comparison_to_assistant() -> None:
    steps = build_steps(comparisons=[matching_comparison("new_vehicle.vin")])

    step = next(item for item in steps if item.step_id == "FIELD-new_vehicle.vin")

    assert step.display_target is ReviewDisplayTarget.ASSISTANT
    assert step.page_field is None
    assert step.result_status == "INSUFFICIENT"
    assert step.requires_reviewer_action is True


@pytest.mark.parametrize(
    "check_id",
    [
        "POLICY-INVOICE-DATE",
        "POLICY-DISPOSAL-DEADLINE",
        "POLICY-NEW-ORIGIN",
        "AFFILIATION-SUBJECT-001",
    ],
)
def test_business_rules_route_to_assistant(check_id: str) -> None:
    steps = build_steps(
        business_checks=[
            ReviewCheck(
                check_id=check_id,
                label="页面外规则",
                status="MATCH",
                reason="规则通过",
            )
        ]
    )

    step = next(item for item in steps if check_id in item.step_id)

    assert step.display_target is ReviewDisplayTarget.ASSISTANT
    assert step.page_field is None


@pytest.mark.parametrize(
    ("check_id", "page_field"),
    [("AFFILIATION-AUX-CUSTOMER-NAME", "application.customer_name")],
)
def test_present_affiliation_safeguard_routes_to_its_page_field(
    check_id: str,
    page_field: str,
) -> None:
    steps = build_steps(
        page_fields={page_field: "页面值"},
        business_checks=[
            ReviewCheck(
                check_id=check_id,
                label="辅助页面字段",
                status="MATCH",
                reason="页面与材料一致",
            )
        ],
    )

    step = next(item for item in steps if check_id in item.step_id)

    assert step.display_target is ReviewDisplayTarget.ASSISTANT
    assert step.page_field is None


def test_owner_type_control_is_a_non_writable_system_field() -> None:
    steps = build_steps(
        page_fields={"application.owner_type": "个人"},
        review_fields=[ReviewFieldSnapshot(
            field="application.owner_type",
            label="车辆所有人类型",
            value="个人",
            control_type="select",
            editable=True,
            order=1,
            section="申请信息",
        )],
    )

    step = next(item for item in steps if item.step_id == "FIELD-application.owner_type")
    assert step.result_status == "MATCH"
    assert step.reason == "系统业务字段，无需材料比对"
    assert step.writable is False


def test_external_check_routes_to_assistant() -> None:
    steps = build_steps(
        external_checks=[
            ReviewCheck(
                check_id="QR-1",
                label="二维码官网核验",
                status="MATCH",
                reason="官网核验通过",
            )
        ]
    )

    assert steps[0].display_target is ReviewDisplayTarget.ASSISTANT
    assert steps[0].page_field is None


def test_complete_material_report_creates_no_assistant_step() -> None:
    steps = build_steps(
        completeness=MaterialCompletenessReport(
            phase="EXTRACTED",
            status="COMPLETE",
            enforced=False,
        )
    )

    assert not any(item.category == "MATERIAL" for item in steps)


def test_duplicate_material_issue_and_limitation_are_shown_once() -> None:
    issue = MaterialCompletenessIssue(
        code="MISSING_MATERIAL",
        reason_code="recognition_failed",
        reason_detail="新车发票识别失败或超时",
        material_type="invoice",
        business_scope="new_vehicle",
        message="新车发票未能识别",
        suggested_action="请查看新车发票原图",
    )
    steps = build_steps(
        completeness=MaterialCompletenessReport(
            phase="EXTRACTED",
            status="INCOMPLETE",
            enforced=False,
            issues=[issue],
        ),
        limitations=["新车发票识别失败或超时"],
    )

    material_steps = [item for item in steps if item.category == "MATERIAL"]

    assert len(material_steps) == 1
    assert material_steps[0].display_target is ReviewDisplayTarget.ASSISTANT


def test_non_target_profile_keeps_steps_as_assistant_contracts() -> None:
    steps = build_review_steps(
        request=ReviewRequest(
            page_url="https://example.test/transfer/1",
            business_type="transfer",
            region="default",
            page_fields={"transfer.vin": "VIN-1"},
        ),
        profile=TRANSFER_DEFAULT,
        comparisons=[matching_comparison("transfer.vin")],
        external_checks=[],
        business_checks=[],
        completeness=None,
        limitations=[],
    )

    assert [(item.step_id, item.display_target, item.page_field) for item in steps] == [
        ("FIELD-transfer.vin", ReviewDisplayTarget.ASSISTANT, None)
    ]


def test_assistant_match_remains_in_contract_but_needs_no_reviewer_action():
    steps = build_steps(business_checks=[ReviewCheck(
        check_id="POLICY-INVOICE-DATE",
        label="新车发票日期政策核验",
        status="MATCH",
        reason="符合政策",
    )])
    step = next(item for item in steps if item.step_id == "BUSINESS-POLICY-INVOICE-DATE")
    assert step.display_target == "ASSISTANT"
    assert step.requires_reviewer_action is False


def test_scrap_field_catalog_follows_the_current_dom_inventory() -> None:
    inventory = [
        ReviewFieldSnapshot(
            field="new_vehicle.vin",
            label="新车车架号",
            value="VIN-1",
            control_type="text",
            order=2,
        ),
        ReviewFieldSnapshot(
            field=None,
            label="页面新增字段",
            value="新增值",
            control_type="text",
            order=1,
        ),
        ReviewFieldSnapshot(
            field="new_vehicle.fuel_type",
            label="新车燃料类型",
            value="柴油",
            control_type="select",
            order=3,
        ),
    ]

    field_steps = [
        item
        for item in build_steps(
            page_fields={"new_vehicle.vin": "VIN-1"},
            comparisons=[matching_comparison("new_vehicle.vin")],
            review_fields=inventory,
        )
        if item.category == "FIELD"
    ]

    assert [item.label for item in field_steps] == [
        "页面新增字段",
        "新车车架号",
        "新车燃料类型",
    ]
    assert [item.step_id for item in field_steps] == [
        "FIELD-DOM-1",
        "FIELD-new_vehicle.vin",
        "FIELD-new_vehicle.fuel_type",
    ]
    assert field_steps[0].result_status == "INSUFFICIENT"
    assert field_steps[1].result_status == "MATCH"
    assert field_steps[2].result_status == "INSUFFICIENT"


def test_affiliation_controls_are_compared_with_the_subject_type() -> None:
    subject = ReviewCheck(
        check_id="AFFILIATION-SUBJECT-001",
        label="新旧车主体关系",
        status="MATCH",
        reason="主体关系通过",
        values=[
            {"source": "旧车主体类型", "value": "COMPANY"},
            {"source": "新车主体类型", "value": "COMPANY"},
        ],
    )
    inventory = [
        ReviewFieldSnapshot(
            field="old_vehicle.affiliation",
            label="报废车挂靠",
            value="公司",
            control_type="select",
            order=1,
            operation_only=True,
        ),
        ReviewFieldSnapshot(
            field="new_vehicle.affiliation",
            label="新车挂靠",
            value="",
            control_type="select",
            order=2,
            operation_only=True,
        ),
    ]

    field_steps = [
        item
        for item in build_steps(business_checks=[subject], review_fields=inventory)
        if item.category == "FIELD"
    ]

    assert [(item.label, item.result_status) for item in field_steps] == [
        ("报废车挂靠", "MATCH"),
        ("新车挂靠", "MATCH"),
    ]
    assert "自动填写" in field_steps[1].reason


def test_affiliation_auxiliary_control_uses_its_material_check() -> None:
    auxiliary_checks = [
        ReviewCheck(
            check_id=check_id,
            label="主体辅助字段",
            status="MATCH",
            reason="页面与主体材料一致",
        )
        for check_id in ("AFFILIATION-AUX-CUSTOMER-NAME",)
    ]
    field_steps = [
        item
        for item in build_steps(
            page_fields={"application.customer_name": "甲公司"},
            business_checks=auxiliary_checks,
            review_fields=[
                ReviewFieldSnapshot(
                    field="application.customer_name",
                    label="客户名称",
                    value="甲公司",
                    order=1,
                )
            ],
        )
        if item.category == "FIELD"
    ]

    assert len(field_steps) == 1
    assert field_steps[0].step_id == "FIELD-application.customer_name"
    assert field_steps[0].result_status == "MATCH"


def test_page_only_field_is_visible_but_never_falsely_marked_as_matching() -> None:
    step = next(
        item
        for item in build_steps(
            review_fields=[
                ReviewFieldSnapshot(
                    field="new_vehicle.fuel_type",
                    label="新车燃料类型",
                    value="柴油",
                    control_type="select",
                    order=1,
                )
            ]
        )
        if item.step_id == "FIELD-new_vehicle.fuel_type"
    )

    assert step.label == "新车燃料类型"
    assert step.result_status == "INSUFFICIENT"
    assert step.requires_reviewer_action is True
    assert [(item.source, item.value) for item in step.values] == [
        ("申请页面字段", "柴油")
    ]


def test_missing_configured_page_field_becomes_actionable_assistant_step():
    step = next(item for item in build_steps(
        comparisons=[matching_comparison("new_vehicle.vin")],
    ) if item.step_id == "FIELD-new_vehicle.vin")
    assert step.display_target == "ASSISTANT"
    assert step.result_status == "INSUFFICIENT"
    assert step.requires_reviewer_action is True


def test_changchun_collected_field_routes_to_assistant() -> None:
    steps = build_review_steps(
        request=ReviewRequest(
            page_url="https://admin.forjtruck.com/scrap-replace-changchun/review/1",
            region="changchun",
            page_fields={"new_vehicle.vin": "VIN-1"},
        ),
        profile=SCRAP_REPLACEMENT_CHANGCHUN,
        comparisons=[matching_comparison("new_vehicle.vin")],
        external_checks=[],
        business_checks=[],
        completeness=None,
        limitations=[],
    )

    step = next(item for item in steps if item.step_id == "FIELD-new_vehicle.vin")

    assert step.display_target is ReviewDisplayTarget.ASSISTANT
    assert step.page_field is None
    assert step.requires_reviewer_action is False


def test_ambiguous_collected_page_field_routes_to_assistant() -> None:
    steps = build_review_steps(
        request=ReviewRequest(
            page_url="https://admin.forjtruck.com/scrap-replace-qingdao/review/1",
            region="qingdao",
            page_fields={"new_vehicle.vin": "VIN-1"},
            collection_diagnostics={
                "ambiguous_fields": ["new_vehicle.vin"],
            },
        ),
        profile=SCRAP_REPLACEMENT_QINGDAO,
        comparisons=[matching_comparison("new_vehicle.vin")],
        external_checks=[],
        business_checks=[],
        completeness=None,
        limitations=[],
    )

    step = next(item for item in steps if item.step_id == "FIELD-new_vehicle.vin")

    assert step.display_target is ReviewDisplayTarget.ASSISTANT
    assert step.result_status == "INSUFFICIENT"
    assert step.requires_reviewer_action is True
