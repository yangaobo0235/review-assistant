from app.models.review import FieldObservation, FieldStatus
from app.rules.aggregate import aggregate_field, aggregate_old_vehicle_vin


def observation(
    field: str,
    value: str,
    source_id: str,
    source_type: str = "image",
) -> FieldObservation:
    return FieldObservation(
        field=field,
        source_type=source_type,
        source_id=source_id,
        value=value,
    )


def test_aggregate_preserves_evidence_and_uses_page_format_for_equivalent_values() -> None:
    observations = [
        observation("old_vehicle.vin", "ab c", "img-1"),
        observation("old_vehicle.vin", "ABC", "review_page", "page"),
    ]

    comparison = aggregate_field("old_vehicle.vin", observations)

    assert comparison.status is FieldStatus.MATCH
    assert comparison.left_value == "ABC"
    assert comparison.right_value == "ABC"
    assert [item.detail for item in comparison.evidence] == ["img-1", "review_page"]


def test_aggregate_reports_conflict_without_overwriting_sources() -> None:
    observations = [
        observation("new_vehicle.owner", "张三", "img-4"),
        observation("new_vehicle.owner", "李四", "img-5"),
        observation("new_vehicle.owner", "张三", "review_page", "page"),
    ]

    comparison = aggregate_field("new_vehicle.owner", observations)

    assert comparison.status is FieldStatus.CONFLICT
    assert len(comparison.evidence) == 3
    assert [(item.detail, item.value) for item in comparison.evidence] == [
        ("img-4", "张三"),
        ("img-5", "李四"),
        ("review_page", "张三"),
    ]
    assert "不同值" in comparison.message


def test_aggregate_marks_only_the_minority_value_as_conflicting() -> None:
    comparison = aggregate_field(
        "new_vehicle.vin",
        [
            observation("new_vehicle.vin", "VIN-A", "img-1"),
            observation("new_vehicle.vin", "VIN-A", "img-2"),
            observation("new_vehicle.vin", "VIN-B", "review_page", "page"),
        ],
    )

    assert comparison.status is FieldStatus.CONFLICT
    assert [item.conflicting for item in comparison.evidence] == [False, False, True]


def test_aggregate_gives_verified_qr_value_authority_over_a_majority() -> None:
    comparison = aggregate_field(
        "old_vehicle.vin",
        [
            observation("old_vehicle.vin", "VIN-IMAGE", "img-1"),
            observation("old_vehicle.vin", "VIN-IMAGE", "review_page", "page"),
            observation("old_vehicle.vin", "VIN-OFFICIAL", "qr-1", "qr_page"),
        ],
    )

    assert comparison.status is FieldStatus.CONFLICT
    assert [item.conflicting for item in comparison.evidence] == [True, True, False]


def test_aggregate_marks_every_value_when_official_values_conflict() -> None:
    comparison = aggregate_field(
        "old_vehicle.vin",
        [
            observation("old_vehicle.vin", "VIN-A", "qr-1", "qr_page"),
            observation("old_vehicle.vin", "VIN-B", "qr-2", "qr_page"),
            observation("old_vehicle.vin", "VIN-A", "img-1"),
        ],
    )

    assert comparison.status is FieldStatus.CONFLICT
    assert [item.conflicting for item in comparison.evidence] == [True, True, True]


def test_aggregate_marks_every_value_when_non_official_votes_tie() -> None:
    comparison = aggregate_field(
        "new_vehicle.vin",
        [
            observation("new_vehicle.vin", "VIN-A", "img-1"),
            observation("new_vehicle.vin", "VIN-B", "review_page", "page"),
        ],
    )

    assert comparison.status is FieldStatus.CONFLICT
    assert [item.conflicting for item in comparison.evidence] == [True, True]


def test_aggregate_does_not_mark_normalized_equivalent_values() -> None:
    comparison = aggregate_field(
        "old_vehicle.vin",
        [
            observation("old_vehicle.vin", "vin a", "img-1"),
            observation("old_vehicle.vin", "VINA", "review_page", "page"),
        ],
    )

    assert comparison.status is FieldStatus.MATCH
    assert [item.conflicting for item in comparison.evidence] == [False, False]


def test_invoice_code_matches_the_same_numeric_invoice_number() -> None:
    comparison = aggregate_field(
        "invoice.code",
        [
            observation("invoice.code", "26320000000801433801", "invoice-1"),
            observation("invoice.code", "26320000000801433801", "review_page", "page"),
        ],
    )

    assert comparison.status is FieldStatus.MATCH


def test_invoice_number_ignores_label_and_hidden_formatting_noise() -> None:
    comparison = aggregate_field(
        "invoice.invoice_no",
        [
            observation("invoice.invoice_no", "数电号码：2632 0000 0008 0143 3801", "invoice-1"),
            observation("invoice.invoice_no", "26320000000801433801", "review_page", "page"),
        ],
    )

    assert comparison.status is FieldStatus.MATCH


def test_aggregate_owner_display_removes_appended_social_credit_code() -> None:
    comparison = aggregate_field(
        "old_vehicle.owner",
        [
            observation(
                "old_vehicle.owner",
                "丹阳市双跃危险货物运输有限公司/统一社会信用代码/91321181730111164",
                "old_vehicle-02",
            ),
            observation("old_vehicle.owner", "丹阳市双跃危险品运输有限公司", "review_page", "page"),
        ],
    )

    assert comparison.left_value == "丹阳市双跃危险货物运输有限公司"
    assert comparison.right_value == "丹阳市双跃危险品运输有限公司"
    assert comparison.status is FieldStatus.CONFLICT


def test_aggregate_requires_review_for_one_source() -> None:
    comparison = aggregate_field(
        "invoice.code",
        [observation("invoice.code", "123", "review_page", "page")],
    )

    assert comparison.status is FieldStatus.REVIEW_REQUIRED
    assert comparison.message == "页面字段已采集，但未从材料中取得可核验值"
    assert [item.conflicting for item in comparison.evidence] == [False]


def test_uncertain_flag_veto_only_applies_when_explicitly_enabled() -> None:
    """默认（既有业务）保持分支前语义；目标 Profile 显式启用一票否决。"""
    observations = [
        FieldObservation(
            field="new_vehicle.vin",
            source_type="image",
            source_id="img-1",
            value="VIN-1",
            uncertain=True,
        ),
        observation("new_vehicle.vin", "VIN-1", "review_page", "page"),
    ]

    legacy = aggregate_field("new_vehicle.vin", observations)
    assert legacy.status is FieldStatus.MATCH

    target = aggregate_field(
        "new_vehicle.vin", observations, uncertain_requires_review=True
    )
    assert target.status is FieldStatus.REVIEW_REQUIRED
    assert target.message == "图片识别结果不确定，请核对原图"


def test_aggregate_requires_review_when_all_sources_are_empty() -> None:
    comparison = aggregate_field(
        "invoice.code",
        [observation("invoice.code", " ", "review_page", "page")],
    )

    assert comparison.status is FieldStatus.REVIEW_REQUIRED
    assert comparison.message == "页面与图片均未取得有效值"
    assert comparison.evidence == []


def test_aggregate_equivalent_date_uses_page_format_for_display() -> None:
    comparison = aggregate_field(
        "invoice.invoice_date",
        [
            observation("invoice.invoice_date", "2026年07月29日", "img-1"),
            observation("invoice.invoice_date", "2026-07-29", "review_page", "page"),
        ],
    )

    assert comparison.status is FieldStatus.MATCH
    assert comparison.left_value == "2026-07-29"
    assert comparison.right_value == "2026-07-29"


def test_aggregate_preserves_structured_image_identity() -> None:
    item = FieldObservation(
        field="new_vehicle.vin",
        source_type="image",
        source_id="new_vehicle-02",
        value="NEW-VIN",
        document_type="vehicle_license",
        image_index=6,
        image_id="new_vehicle-02",
        business_scope="new_vehicle",
        group_title="新车资料",
        group_order=2,
    )

    comparison = aggregate_field("new_vehicle.vin", [item])
    EvidenceFact = comparison.evidence[0]

    assert EvidenceFact.image_id == "new_vehicle-02"
    assert EvidenceFact.business_scope == "new_vehicle"
    assert EvidenceFact.group_title == "新车资料"
    assert EvidenceFact.group_order == 2
    assert EvidenceFact.document_type == "vehicle_license"


def test_aggregate_distinguishes_application_page_and_qr_official_evidence() -> None:
    comparison = aggregate_field(
        "old_vehicle.vin",
        [
            observation("old_vehicle.vin", "VIN-1", "review_page", "page"),
            observation("old_vehicle.vin", "VIN-1", "qr-2", "qr_page"),
        ],
    )

    assert [item.source for item in comparison.evidence] == [
        "申请页面字段",
        "二维码官网字段",
    ]


def vehicle_vin_observation(value: str, source_id: str, source_type: str, document_type: str | None = None) -> FieldObservation:
    return FieldObservation(
        field="old_vehicle.vin",
        value=value,
        source_id=source_id,
        source_type=source_type,
        document_type=document_type,
    )


def test_old_vehicle_vin_uses_qr_as_authority_and_only_document_suffixes() -> None:
    comparison = aggregate_old_vehicle_vin([
        vehicle_vin_observation("VIN-0000ABCDEF12", "page", "page"),
        vehicle_vin_observation("VIN-0000ABCDEF12", "qr", "qr_page"),
        vehicle_vin_observation("OTHER-9999ABCDEF12", "license", "image", "vehicle_license"),
        vehicle_vin_observation("REG-8888ABCDEF12", "registration", "image", "registration_certificate"),
        vehicle_vin_observation("WRONG-000000999999", "scrap", "image", "scrap_certificate"),
    ])

    assert comparison.status is FieldStatus.MATCH
    assert "后 8 位一致" in comparison.message
    assert all(item.source_id != "scrap" or not item.conflicting for item in comparison.evidence)


def test_old_vehicle_vin_rejects_page_or_document_suffix_conflicts() -> None:
    page_conflict = aggregate_old_vehicle_vin([
        vehicle_vin_observation("PAGE-WRONG-ABCDEF", "page", "page"),
        vehicle_vin_observation("VIN-000000ABCDEF", "qr", "qr_page"),
    ])
    suffix_conflict = aggregate_old_vehicle_vin([
        vehicle_vin_observation("VIN-000000ABCDEF", "page", "page"),
        vehicle_vin_observation("VIN-000000ABCDEF", "qr", "qr_page"),
        vehicle_vin_observation("DOC-000000999999", "license", "image", "vehicle_license"),
    ])

    assert page_conflict.status is FieldStatus.CONFLICT
    assert suffix_conflict.status is FieldStatus.CONFLICT


def test_old_vehicle_vin_requires_one_unique_qr_value() -> None:
    missing = aggregate_old_vehicle_vin([
        vehicle_vin_observation("VIN-000000ABCDEF", "page", "page"),
    ])
    multiple = aggregate_old_vehicle_vin([
        vehicle_vin_observation("VIN-000000ABCDEF", "qr-1", "qr_page"),
        vehicle_vin_observation("VIN-000000999999", "qr-2", "qr_page"),
    ])

    assert missing.status is FieldStatus.REVIEW_REQUIRED
    assert multiple.status is FieldStatus.CONFLICT
