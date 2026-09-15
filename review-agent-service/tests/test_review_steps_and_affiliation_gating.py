import pytest

from app.agent.models import AgentBatchResult, CheckResult
from app.agent.workflow import ReviewWorkflow
from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO, TRANSFER_DEFAULT
from app.models.review import (
    FieldComparison,
    FieldObservation,
    FieldStatus,
    ReviewDisplayTarget,
    ReviewRequest,
)


def EvidenceFact(field: str, value: str, source_id: str, document_type: str) -> FieldObservation:
    return FieldObservation(
        field=field,
        value=value,
        source_type="image",
        source_id=source_id,
        document_type=document_type,
    )


def comparison(field: str, value: str) -> FieldComparison:
    return FieldComparison(
        field=field,
        left_value=value,
        right_value=value,
        status=FieldStatus.MATCH,
        message="多个来源字段一致",
    )


def test_affiliation_actions_follow_confirmed_subject_types_even_if_auxiliary_customer_check_differs() -> None:
    request = ReviewRequest(
        page_url="https://example.test/scrap",
        page_fields={
            "application.owner_type": "个人",
            "page_ocr.new_vehicle_vin": "VIN-NEW",
            "application.customer_name": "李四",
        },
    )
    state = {
        "request": request,
        "profile": SCRAP_REPLACEMENT_QINGDAO,
        "batch": AgentBatchResult(observations=[
            EvidenceFact("identity_card.name", "张三", "id-front", "identity_card"),
            EvidenceFact("identity_card.side", "FRONT", "id-front", "identity_card"),
            EvidenceFact("identity_card.side", "BACK", "id-back", "identity_card"),
        ]),
        "response": type("Response", (), {
            "comparisons": [
                comparison("old_vehicle.owner", "张三"),
                comparison("new_vehicle.owner", "张三"),
                comparison("new_vehicle.vin", "VIN-NEW"),
            ],
        })(),
        "qr_checks": [],
    }

    result = ReviewWorkflow._run_affiliation_subject(ReviewWorkflow.__new__(ReviewWorkflow)._execution_context(state))

    assert result.checks[0].check_id == "AFFILIATION-SUBJECT-001"
    assert result.checks[0].status == "MATCH"
    assert {item.check_id: item.status for item in result.checks[1:]} == {
        "AFFILIATION-AUX-CUSTOMER-NAME": "CONFLICT",
    }
    assert [item.owner_type for item in result.page_action_candidates] == [
        "PERSONAL",
        "PERSONAL",
    ]


@pytest.mark.parametrize("ocr_vin", ["vin-new", "WRONG-VIN", "", None])
def test_affiliation_actions_ignore_ocr_vin_and_accept_company_labels(ocr_vin) -> None:
    request = ReviewRequest(
        page_url="https://example.test/scrap",
        page_fields={
            "application.owner_type": "公司",
            **({"page_ocr.new_vehicle_vin": ocr_vin} if ocr_vin is not None else {}),
            "application.customer_name": "甲运输有限公司",
        },
    )
    state = {
        "request": request,
        "profile": SCRAP_REPLACEMENT_QINGDAO,
        "batch": AgentBatchResult(observations=[
            EvidenceFact("business_license.company_name", "甲运输有限公司", "license-a", "business_license"),
            EvidenceFact("business_license.legal_representative", "张三", "license-a", "business_license"),
        ]),
        "response": type("Response", (), {
            "comparisons": [
                comparison("old_vehicle.owner", "甲运输有限公司"),
                comparison("new_vehicle.owner", "甲运输有限公司"),
                comparison("new_vehicle.vin", "VIN-NEW"),
            ],
        })(),
        "qr_checks": [],
    }

    result = ReviewWorkflow._run_affiliation_subject(ReviewWorkflow.__new__(ReviewWorkflow)._execution_context(state))

    assert [item.status for item in result.checks] == ["MATCH", "MATCH"]
    assert all("VIN" not in item.check_id for item in result.checks)
    assert [action.field for action in result.page_action_candidates] == [
        "old_vehicle.affiliation",
        "new_vehicle.affiliation",
    ]


def test_prepare_review_steps_includes_only_configured_capabilities_and_maps_statuses() -> None:
    request = ReviewRequest(
        page_url="https://example.test/transfer",
        business_type="transfer",
        region="default",
    )
    state = {
        "request": request,
        "profile": TRANSFER_DEFAULT,
        "response": type("Response", (), {
            "comparisons": [FieldComparison(
                field="transfer.vin", status=FieldStatus.REVIEW_REQUIRED,
                message="仅有一个有效来源，证据不足",
            )],
        })(),
        "cross_checks": [CheckResult(
            check_id="CROSS-TRANSFER-VIN-001", label="过户车架号", status="MATCH", reason="一致"
        )],
        "qr_checks": [],
        "batch": AgentBatchResult(),
    }

    result = ReviewWorkflow._prepare_review_steps(state)

    assert [(item.step_id, item.category, item.result_status) for item in result["review_tasks"]] == [
        ("FIELD-transfer.vin", "FIELD", "INSUFFICIENT"),
        ("BUSINESS-CROSS-TRANSFER-VIN-001", "BUSINESS_RULE", "MATCH"),
    ]
    # 过户不是页内交互目标 Profile，所有步骤保持在助手面板。
    assert all(
        item.display_target is ReviewDisplayTarget.ASSISTANT
        and item.page_field is None
        for item in result["review_tasks"]
    )
    assert not any("QR" in item.step_id or "AFFILIATION" in item.step_id for item in result["review_tasks"])


def test_scrap_missing_auxiliary_values_are_independent_steps_and_block_final_intent() -> None:
    request = ReviewRequest(page_url="https://example.test/scrap")
    state = {
        "request": request,
        "profile": SCRAP_REPLACEMENT_QINGDAO,
        "batch": AgentBatchResult(),
        "response": type("Response", (), {"comparisons": []})(),
        "qr_checks": [],
    }

    result = ReviewWorkflow._run_affiliation_subject(ReviewWorkflow.__new__(ReviewWorkflow)._execution_context(state))
    steps = ReviewWorkflow._prepare_review_steps({
        **state,
        "cross_checks": list(result.checks),
    })["review_tasks"]

    assert {step.step_id for step in steps} >= {
        "BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME",
    }
    assert all(step.result_status == "INSUFFICIENT" for step in steps if "AFFILIATION-AUX" in step.step_id)
    # 页面字段未采集时，辅助守护步骤只能留在助手面板。
    assert all(
        step.display_target is ReviewDisplayTarget.ASSISTANT
        and step.page_field is None
        for step in steps
    )
    assert result.page_action_candidates == ()
