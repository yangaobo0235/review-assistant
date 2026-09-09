from app.models.review import FieldObservation
from app.rules.transfer_registration import summarize_registration


def image_observation(field: str, value: object, source_id: str) -> FieldObservation:
    return FieldObservation(
        field=field,
        source_type="image",
        source_id=source_id,
        value=value,
        document_type="registration_certificate",
        business_scope="transfer",
    )


def test_merges_four_pages_deduplicates_records_and_selects_latest_owner() -> None:
    summary = summarize_registration(
        [
            image_observation("transfer.registration.covered_pages", [1, 2], "reg-12"),
            image_observation(
                "transfer.registration.initial_owner", "甲公司", "reg-12"
            ),
            image_observation(
                "transfer.registration.transfer_records",
                [
                    {"owner": "乙公司", "date": "2024-01-01", "page": 2, "order": 1},
                ],
                "reg-12",
            ),
            image_observation("transfer.registration.covered_pages", [3, 4], "reg-34"),
            image_observation(
                "transfer.registration.transfer_records",
                [
                    {"owner": "乙公司", "date": "2024-01-01", "page": 2, "order": 1},
                    {"owner": "丙公司", "date": "2026-08-16", "page": 4, "order": 2},
                ],
                "reg-34",
            ),
        ]
    )

    assert summary.complete is True
    assert summary.owners == ("甲公司", "乙公司", "丙公司")
    assert summary.latest_owner == "丙公司"
    assert len(summary.records) == 2


def test_missing_page_keeps_history_incomplete() -> None:
    summary = summarize_registration(
        [
            image_observation("transfer.registration.covered_pages", [1, 2, 3], "reg"),
            image_observation("transfer.registration.initial_owner", "甲公司", "reg"),
        ]
    )

    assert summary.complete is False
    assert summary.latest_owner is None


def test_invalid_record_shape_marks_history_uncertain() -> None:
    summary = summarize_registration(
        [
            image_observation(
                "transfer.registration.covered_pages", [1, 2, 3, 4], "reg"
            ),
            image_observation(
                "transfer.registration.transfer_records",
                [{"page": 4, "order": 1}],
                "reg",
            ),
        ]
    )

    assert summary.uncertain is True
    assert summary.latest_owner is None


def test_model_uncertain_fields_keep_history_incomplete() -> None:
    summary = summarize_registration(
        [
            image_observation(
                "transfer.registration.covered_pages", [1, 2, 3, 4], "reg"
            ),
            image_observation("transfer.registration.initial_owner", "甲公司", "reg"),
            image_observation(
                "transfer.uncertain_fields", ["registration.transfer_records"], "reg"
            ),
        ]
    )

    assert summary.complete is False
    assert summary.uncertain is True


def test_conflicting_owners_at_same_record_position_make_history_uncertain() -> None:
    summary = summarize_registration(
        [
            image_observation(
                "transfer.registration.covered_pages", [1, 2, 3, 4], "reg-pages"
            ),
            image_observation(
                "transfer.registration.initial_owner", "甲公司", "reg-pages"
            ),
            image_observation(
                "transfer.registration.transfer_records",
                [
                    {"owner": "乙公司", "date": "2026-08-16", "page": 4, "order": 1},
                ],
                "reg-a",
            ),
            image_observation(
                "transfer.registration.transfer_records",
                [
                    {"owner": "丙公司", "date": "2026-08-16", "page": 4, "order": 1},
                ],
                "reg-b",
            ),
        ]
    )

    assert summary.complete is False
    assert summary.uncertain is True
    assert summary.latest_owner is None


def test_conflicting_initial_owners_make_history_uncertain() -> None:
    summary = summarize_registration(
        [
            image_observation(
                "transfer.registration.covered_pages", [1, 2, 3, 4], "reg"
            ),
            image_observation("transfer.registration.initial_owner", "甲公司", "reg-a"),
            image_observation("transfer.registration.initial_owner", "乙公司", "reg-b"),
        ]
    )

    assert summary.complete is False
    assert summary.uncertain is True
