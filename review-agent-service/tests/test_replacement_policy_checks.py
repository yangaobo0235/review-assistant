import pytest

from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO
from app.businesses.replacement_policies import (
    CHANGCHUN_REPLACEMENT_POLICY,
    QINGDAO_REPLACEMENT_POLICY,
)
from app.models.review import FieldObservation, ReviewRequest
from app.rules.final_advice import build_final_advice
from app.rules.replacement_policy_checks import build_replacement_policy_checks
from app.rules.review_step_routing import build_review_steps


def observation(field: str, value: str, document_type: str) -> FieldObservation:
    return FieldObservation(
        field=field,
        source_type="image",
        source_id=f"{document_type}-1",
        document_type=document_type,
        business_scope="new_vehicle" if document_type == "invoice" else "old_vehicle",
        value=value,
    )


@pytest.mark.parametrize(
    ("policy", "invoice_date", "expected"),
    [
        (QINGDAO_REPLACEMENT_POLICY, "2026-09-01", "MATCH"),
        (QINGDAO_REPLACEMENT_POLICY, "2026-09-30", "MATCH"),
        (QINGDAO_REPLACEMENT_POLICY, "2026-08-31", "CONFLICT"),
        (QINGDAO_REPLACEMENT_POLICY, "2026-10-01", "CONFLICT"),
        (CHANGCHUN_REPLACEMENT_POLICY, "2026-07-01", "MATCH"),
        (CHANGCHUN_REPLACEMENT_POLICY, "2026-09-30", "MATCH"),
        (CHANGCHUN_REPLACEMENT_POLICY, "2026-06-30", "CONFLICT"),
        (CHANGCHUN_REPLACEMENT_POLICY, "2026-10-01", "CONFLICT"),
    ],
)
def test_invoice_date_policy_boundaries(policy, invoice_date, expected) -> None:
    checks = build_replacement_policy_checks(
        policy,
        [
            observation("invoice.invoice_date", invoice_date, "invoice"),
            observation(
                "old_vehicle.recycle_date",
                str(policy.disposal_deadline),
                "scrap_certificate",
            ),
            observation("new_vehicle.origin", "长春市", "invoice"),
        ],
    )

    assert {item.check_id: item.status for item in checks}[
        "POLICY-INVOICE-DATE"
    ] == expected


def test_changchun_requires_origin_and_qingdao_does_not() -> None:
    changchun = build_replacement_policy_checks(
        CHANGCHUN_REPLACEMENT_POLICY,
        [
            observation("invoice.invoice_date", "2026-08-01", "invoice"),
            observation("old_vehicle.recycle_date", "2026-12-31", "scrap_certificate"),
            observation("new_vehicle.origin", "青岛市", "invoice"),
        ],
    )
    changchun_unreadable = build_replacement_policy_checks(
        CHANGCHUN_REPLACEMENT_POLICY,
        [
            observation("invoice.invoice_date", "2026-08-01", "invoice"),
            observation("old_vehicle.recycle_date", "2026-12-31", "scrap_certificate"),
            observation("new_vehicle.origin", "无法识别", "invoice"),
        ],
    )
    qingdao = build_replacement_policy_checks(
        QINGDAO_REPLACEMENT_POLICY,
        [
            observation("invoice.invoice_date", "2026-09-10", "invoice"),
            observation("old_vehicle.recycle_date", "2026-10-31", "scrap_certificate"),
        ],
    )

    assert {item.check_id: item.status for item in changchun}[
        "POLICY-NEW-ORIGIN"
    ] == "CONFLICT"
    assert {item.check_id: item.status for item in changchun_unreadable}[
        "POLICY-NEW-ORIGIN"
    ] == "INSUFFICIENT"
    assert {item.check_id: item.status for item in qingdao}[
        "POLICY-NEW-ORIGIN"
    ] == "MATCH"


def test_policy_uses_image_evidence_and_reports_missing_as_insufficient() -> None:
    checks = build_replacement_policy_checks(
        QINGDAO_REPLACEMENT_POLICY,
        [
            FieldObservation(
                field="invoice.invoice_date",
                source_type="page",
                source_id="review-page",
                value="2026-09-10",
            )
        ],
    )

    statuses = {item.check_id: item.status for item in checks}
    assert statuses == {
        "POLICY-INVOICE-DATE": "INSUFFICIENT",
        "POLICY-DISPOSAL-DEADLINE": "INSUFFICIENT",
        # 青岛没有产地规则，产地检查始终仅展示为 MATCH。
        "POLICY-NEW-ORIGIN": "MATCH",
    }


@pytest.mark.parametrize(
    "policy,value,expected",
    [
        (QINGDAO_REPLACEMENT_POLICY, "2026-10-31", "MATCH"),
        (QINGDAO_REPLACEMENT_POLICY, "2026-11-01", "CONFLICT"),
        (CHANGCHUN_REPLACEMENT_POLICY, "2026-12-31", "MATCH"),
        (CHANGCHUN_REPLACEMENT_POLICY, "2027-01-01", "CONFLICT"),
    ],
)
def test_disposal_deadline_is_inclusive(policy, value, expected):
    checks = build_replacement_policy_checks(
        policy, [observation("old_vehicle.recycle_date", value, "scrap_certificate")]
    )
    assert {item.check_id: item.status for item in checks}[
        "POLICY-DISPOSAL-DEADLINE"
    ] == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        ("长春", "MATCH"),
        ("长春市", "MATCH"),
        ("吉林省长春市", "MATCH"),
        ("青岛", "CONFLICT"),
        ("", "INSUFFICIENT"),
        ("无法识别", "INSUFFICIENT"),
        ("???", "INSUFFICIENT"),
        ("--", "INSUFFICIENT"),
        ("未知", "INSUFFICIENT"),
        ("长*", "INSUFFICIENT"),
    ],
)
def test_changchun_origin_requires_readable_evidence(value, expected):
    checks = build_replacement_policy_checks(
        CHANGCHUN_REPLACEMENT_POLICY,
        [observation("new_vehicle.origin", value, "invoice")],
    )
    assert {item.check_id: item.status for item in checks}[
        "POLICY-NEW-ORIGIN"
    ] == expected


def test_qingdao_origin_is_displayed_with_full_original_image_evidence():
    origin = observation("new_vehicle.origin", "青岛市", "invoice").model_copy(
        update={"image_id": "invoice-img", "image_index": 3}
    )
    checks = build_replacement_policy_checks(QINGDAO_REPLACEMENT_POLICY, [origin])
    check = next(item for item in checks if item.check_id == "POLICY-NEW-ORIGIN")
    assert check.label == "新车发票产地（仅展示）"
    assert check.status == "MATCH"
    assert check.evidence[0]["source_id"] == "invoice-1"
    assert {
        key: check.evidence[0][key]
        for key in ("image_id", "image_index", "document_type", "value")
    } == {
        "image_id": "invoice-img",
        "image_index": 3,
        "document_type": "invoice",
        "value": "青岛市",
    }


def test_policy_ignores_page_values_and_keeps_conflicting_image_sources():
    original = observation("invoice.invoice_date", "2026-09-10", "invoice")
    page = original.model_copy(update={"source_type": "page", "value": "2020-01-01"})
    checks = build_replacement_policy_checks(
        QINGDAO_REPLACEMENT_POLICY, [original, page]
    )
    assert checks[0].status == "MATCH"
    assert len(checks[0].evidence) == 1
    conflict = original.model_copy(
        update={"source_id": "invoice-2", "value": "2026-10-01"}
    )
    checks = build_replacement_policy_checks(
        QINGDAO_REPLACEMENT_POLICY, [original, conflict, page]
    )
    assert checks[0].status == "INSUFFICIENT"
    assert {item["source_id"] for item in checks[0].evidence} == {
        "invoice-1",
        "invoice-2",
    }


@pytest.mark.parametrize(
    "origin_observations",
    [
        [],
        [observation("new_vehicle.origin", "无法识别", "invoice")],
        [observation("new_vehicle.origin", "长*", "invoice")],
        [
            observation("new_vehicle.origin", "青岛市", "invoice"),
            observation("new_vehicle.origin", "长春市", "invoice").model_copy(
                update={"source_id": "invoice-2"}
            ),
        ],
    ],
)
def test_qingdao_unreadable_origin_still_matches_and_can_reach_pass(
    origin_observations,
) -> None:
    """青岛没有产地规则：产地不可读或冲突时不得产生人工步骤或建议 finding。"""
    checks = build_replacement_policy_checks(
        QINGDAO_REPLACEMENT_POLICY,
        [
            observation("invoice.invoice_date", "2026-09-10", "invoice"),
            observation("old_vehicle.recycle_date", "2026-10-31", "scrap_certificate"),
            *origin_observations,
        ],
    )

    origin_check = next(
        item for item in checks if item.check_id == "POLICY-NEW-ORIGIN"
    )
    assert origin_check.status == "MATCH"
    assert all(item.status == "MATCH" for item in checks)

    steps = build_review_steps(
        request=ReviewRequest(
            page_url="https://admin.forjtruck.com/scrap-replace-qingdao/review/1",
            region="qingdao",
        ),
        profile=SCRAP_REPLACEMENT_QINGDAO,
        comparisons=[],
        external_checks=[],
        business_checks=checks,
        completeness=None,
        limitations=[],
    )
    assert not any(step.requires_reviewer_action for step in steps)

    decision, advice = build_final_advice([], checks, [], [], [], [])
    assert decision == "PASS"
    assert advice.findings == []
