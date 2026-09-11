from app.models.review import (
    BusinessType,
    Evidence,
    FieldComparison,
    FieldObservation,
    FieldStatus,
)
from app.rules.cross_document import build_cross_document_checks


def comparison(
    field: str, value: str, status: FieldStatus = FieldStatus.MATCH
) -> FieldComparison:
    return FieldComparison(
        field=field,
        left_value=value,
        right_value=value,
        status=status,
        evidence=[
            Evidence(
                source="图片识别",
                image_id="invoice-image",
                image_index=5,
                document_type="invoice",
                value=value,
            )
        ],
    )


def image_observation(field: str, value: object, source_id: str) -> FieldObservation:
    return FieldObservation(
        field=field,
        source_type="image",
        source_id=source_id,
        value=value,
        document_type="registration_certificate",
        business_scope="transfer",
        image_id="registration-image",
        image_index=2,
        group_title="过户资料",
        group_order=2,
    )


def test_transfer_seller_evidence_ignores_non_string_settled_value() -> None:
    seller = FieldComparison(
        field="transfer.seller_name",
        left_value={"raw": "乙公司"},
        right_value={"raw": "乙公司"},
        status=FieldStatus.MATCH,
    )

    checks = build_cross_document_checks(
        BusinessType.TRANSFER,
        [seller],
        [],
        {},
    )

    seller_check = next(
        item for item in checks if item.check_id == "CROSS-TRANSFER-SELLER-001"
    )
    assert seller_check.status == "INSUFFICIENT"


def test_transfer_cross_checks_match_history_latest_owner_and_later_invoice() -> None:
    comparisons = [
        comparison("transfer.buyer_name", "丙公司"),
        comparison("transfer.seller_name", "乙公司"),
        comparison("transfer.invoice_date", "2026-08-15"),
    ]
    observations = [
        image_observation("transfer.registration.covered_pages", [1, 2, 3, 4], "reg"),
        image_observation("transfer.registration.initial_owner", "甲公司", "reg"),
        image_observation(
            "transfer.registration.transfer_records",
            [
                {"owner": "乙公司", "date": "2024-01-01", "page": 2, "order": 1},
                {"owner": "丙公司", "date": "2026-08-16", "page": 4, "order": 2},
            ],
            "reg",
        ),
    ]

    checks = build_cross_document_checks(
        BusinessType.TRANSFER,
        comparisons,
        observations,
        {"transfer.source_publish_date": "2026-08-13 17:01:31"},
    )

    assert {item.check_id: item.status for item in checks} == {
        "CROSS-TRANSFER-SELLER-001": "MATCH",
        "CROSS-TRANSFER-BUYER-001": "MATCH",
        "CROSS-TRANSFER-DATE-001": "MATCH",
    }
    by_id = {item.check_id: item for item in checks}
    assert {item.image_id for item in by_id["CROSS-TRANSFER-SELLER-001"].evidence} == {
        "invoice-image",
        "registration-image",
    }
    assert {item.image_id for item in by_id["CROSS-TRANSFER-BUYER-001"].evidence} == {
        "invoice-image",
        "registration-image",
    }
    assert {item.image_id for item in by_id["CROSS-TRANSFER-DATE-001"].evidence} == {
        "invoice-image",
        "registration-image",
    }


def test_transfer_cross_checks_are_insufficient_for_missing_pages_and_conflicted_invoice_date() -> (
    None
):
    comparisons = [
        comparison("transfer.buyer_name", "丙公司"),
        comparison("transfer.seller_name", "乙公司"),
        comparison("transfer.invoice_date", "2026-08-15", FieldStatus.CONFLICT),
    ]
    observations = [
        image_observation("transfer.registration.covered_pages", [1, 2, 3], "reg"),
    ]

    checks = build_cross_document_checks(
        BusinessType.TRANSFER,
        comparisons,
        observations,
        {"transfer.source_publish_date": "2026-08-13"},
    )

    assert all(item.status == "INSUFFICIENT" for item in checks)
    seller_check = next(
        item for item in checks if item.check_id == "CROSS-TRANSFER-SELLER-001"
    )
    assert seller_check.reason == "登记证缺少第4页，无法完整校验卖方登记历史"


def test_transfer_invoice_must_be_strictly_later_than_publish_date() -> None:
    checks = build_cross_document_checks(
        BusinessType.TRANSFER,
        [comparison("transfer.invoice_date", "2026-08-13")],
        [],
        {"transfer.source_publish_date": "2026-08-13 17:01:31"},
    )

    date_check = next(
        item for item in checks if item.check_id == "CROSS-TRANSFER-DATE-001"
    )
    assert date_check.status == "INSUFFICIENT"


def test_initial_owner_uncertainty_only_blocks_seller_history() -> None:
    comparisons = [
        comparison("transfer.buyer_name", "丙公司"),
        comparison("transfer.seller_name", "乙公司"),
        comparison("transfer.invoice_date", "2026-08-15"),
    ]
    observations = [
        image_observation("transfer.registration.covered_pages", [1, 2, 3, 4], "reg"),
        image_observation("transfer.registration.initial_owner", "甲公司", "reg"),
        image_observation(
            "transfer.registration.transfer_records",
            [
                {"owner": "乙公司", "date": "2024-01-01", "page": 2, "order": 1},
                {"owner": "丙公司", "date": "2026-08-16", "page": 4, "order": 2},
            ],
            "reg",
        ),
        image_observation(
            "transfer.uncertain_fields", ["registration.initial_owner"], "reg"
        ),
    ]

    checks = {
        item.check_id: item
        for item in build_cross_document_checks(
            BusinessType.TRANSFER,
            comparisons,
            observations,
            {"transfer.source_publish_date": "2026-08-13"},
        )
    }

    assert checks["CROSS-TRANSFER-SELLER-001"].status == "INSUFFICIENT"
    assert checks["CROSS-TRANSFER-SELLER-001"].reason == (
        "登记证初始所有人识别内容异常，无法校验卖方登记历史"
    )
    assert checks["CROSS-TRANSFER-BUYER-001"].status == "MATCH"


def test_transfer_cross_checks_use_only_relevant_registration_evidence() -> None:
    comparisons = [
        comparison("transfer.buyer_name", "丙公司"),
        comparison("transfer.seller_name", "乙公司"),
        comparison("transfer.invoice_date", "2026-08-15"),
    ]
    observations = [
        image_observation(
            "transfer.registration.covered_pages", [1, 2, 3, 4], "reg-pages"
        ),
        image_observation("transfer.registration.initial_owner", "甲公司", "reg-1"),
        image_observation(
            "transfer.registration.transfer_records",
            [
                {"owner": "乙公司", "date": "2024-01-01", "page": 2, "order": 1},
                {"owner": "丙公司", "date": "2026-08-16", "page": 4, "order": 2},
            ],
            "reg-4",
        ),
    ]

    checks = {
        item.check_id: item
        for item in build_cross_document_checks(
            BusinessType.TRANSFER,
            comparisons,
            observations,
            {"transfer.source_publish_date": "2026-08-13"},
        )
    }

    assert len(checks["CROSS-TRANSFER-SELLER-001"].evidence) == 2
    assert len(checks["CROSS-TRANSFER-BUYER-001"].evidence) == 2


def test_transfer_date_chain_requires_registration_date_and_allows_equality() -> None:
    comparisons = [comparison("transfer.invoice_date", "2026-08-15")]
    observations = [
        image_observation("transfer.registration.covered_pages", [1, 2, 3, 4], "reg"),
        image_observation(
            "transfer.registration.transfer_records",
            [
                {"owner": "丙公司", "date": "2026-08-15", "page": 4, "order": 1},
            ],
            "reg",
        ),
    ]

    checks = build_cross_document_checks(
        BusinessType.TRANSFER,
        comparisons,
        observations,
        {"transfer.source_publish_date": "2026-08-13"},
    )

    date_check = next(
        item for item in checks if item.check_id == "CROSS-TRANSFER-DATE-001"
    )
    assert date_check.status == "MATCH"
    assert "转让登记日期" in date_check.label
