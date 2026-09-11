import pytest

from app.models.review import FieldObservation
from app.rules.affiliation_subject_checks import build_affiliation_subject_check


def item(field: str, value: str, source_id: str = "source") -> FieldObservation:
    return FieldObservation(
        field=field,
        source_type="image",
        source_id=source_id,
        document_type="business_license"
        if field.startswith("business_license")
        else "vehicle_license",
        value=value,
    )


def test_same_person_matches_and_different_people_conflict() -> None:
    same = build_affiliation_subject_check("张三", "张三", [])
    different = build_affiliation_subject_check("张三", "李四", [])

    assert same.check.status == "MATCH"
    assert same.owner_types == ("PERSONAL", "PERSONAL")
    assert different.check.status == "CONFLICT"
    assert different.page_actions == ()


def test_different_companies_match_only_with_separate_licenses_and_common_legal_representative() -> (
    None
):
    observations = [
        item("business_license.company_name", "甲运输有限公司", "license-a"),
        item("business_license.legal_representative", "张三", "license-a"),
        item("business_license.company_name", "乙运输有限公司", "license-b"),
        item("business_license.legal_representative", "张三", "license-b"),
    ]

    result = build_affiliation_subject_check(
        "甲运输有限公司",
        "乙运输有限公司",
        observations,
    )

    assert result.check.status == "MATCH"
    assert result.owner_types == ("COMPANY", "COMPANY")
    assert [action.owner_type for action in result.page_actions] == [
        "COMPANY",
        "COMPANY",
    ]


def test_mixed_person_company_requires_matching_legal_representative() -> None:
    matched = build_affiliation_subject_check(
        "张三",
        "甲运输有限公司",
        [
            item("business_license.company_name", "甲运输有限公司", "license-a"),
            item("business_license.legal_representative", "张三", "license-a"),
        ],
    )
    missing = build_affiliation_subject_check("张三", "甲运输有限公司", [])

    assert matched.check.status == "MATCH"
    assert matched.owner_types == ("PERSONAL", "COMPANY")
    assert missing.check.status == "INSUFFICIENT"


def test_different_companies_require_readable_legal_representatives() -> None:
    result = build_affiliation_subject_check(
        "甲运输有限公司",
        "乙运输有限公司",
        [
            item("business_license.company_name", "甲运输有限公司", "license-a"),
            item("business_license.legal_representative", "无法识别", "license-a"),
            item("business_license.company_name", "乙运输有限公司", "license-b"),
            item("business_license.legal_representative", "无法识别", "license-b"),
        ],
    )

    assert result.check.status == "INSUFFICIENT"


def test_conflicting_values_from_one_license_image_are_insufficient_evidence() -> None:
    result = build_affiliation_subject_check(
        "甲运输有限公司",
        "乙运输有限公司",
        [
            item("business_license.company_name", "甲运输有限公司", "license-a"),
            item("business_license.legal_representative", "张三", "license-a"),
            item("business_license.legal_representative", "李四", "license-a"),
            item("business_license.company_name", "乙运输有限公司", "license-b"),
            item("business_license.legal_representative", "张三", "license-b"),
        ],
    )

    assert result.check.status == "INSUFFICIENT"


def test_one_license_source_cannot_support_two_different_companies() -> None:
    result = build_affiliation_subject_check(
        "甲运输有限公司",
        "乙运输有限公司",
        [
            item("business_license.company_name", "甲运输有限公司", "license-a"),
            item("business_license.company_name", "乙运输有限公司", "license-a"),
            item("business_license.legal_representative", "张三", "license-a"),
        ],
    )

    assert result.check.status == "INSUFFICIENT"


@pytest.mark.parametrize("name", ["张*", "???", "?张", "法人未知", "甲公司"])
def test_unreadable_or_non_person_representatives_never_authorize_actions(name):
    observations = [
        item("business_license.company_name", "甲运输有限公司", "license-a"),
        item("business_license.legal_representative", name, "license-a"),
        item("business_license.company_name", "乙运输有限公司", "license-b"),
        item("business_license.legal_representative", name, "license-b"),
    ]
    result = build_affiliation_subject_check(
        "甲运输有限公司", "乙运输有限公司", observations
    )
    assert result.check.status == "INSUFFICIENT"
    assert result.page_actions == ()


@pytest.mark.parametrize(
    "old,new,legal,expected",
    [
        ("甲运输有限公司", "张三", "张三", "MATCH"),
        ("甲运输有限公司", "张三", "李四", "CONFLICT"),
        ("张三", "甲运输有限公司", "李四", "CONFLICT"),
        ("甲运输有限公司", "乙运输有限公司", "李四", "CONFLICT"),
        ("甲运输主体", "张三", "张三", "INSUFFICIENT"),
        ("甲运输有限公司", "甲运输有限责任公司", "张三", "INSUFFICIENT"),
    ],
)
def test_subject_direction_and_name_matrix(old, new, legal, expected):
    observations = [
        item("business_license.company_name", "甲运输有限公司", "license-a"),
        item("business_license.legal_representative", legal, "license-a"),
        item("business_license.company_name", "乙运输有限公司", "license-b"),
        item("business_license.legal_representative", "张三", "license-b"),
    ]
    result = build_affiliation_subject_check(old, new, observations)
    assert result.check.status == expected
    assert bool(result.page_actions) == (expected == "MATCH")


def test_subject_evidence_keeps_owners_and_relevant_license_sources_only():
    observations = [
        item("old_vehicle.owner", "甲运输有限公司", "old-image"),
        item("new_vehicle.owner", "乙运输有限公司", "new-image"),
        item("business_license.company_name", "甲运输有限公司", "license-a"),
        item("business_license.legal_representative", "张三", "license-a"),
        item("business_license.company_name", "乙运输有限公司", "license-b"),
        item("business_license.legal_representative", "张三", "license-b"),
        item("business_license.company_name", "无关有限公司", "unrelated"),
        item("business_license.legal_representative", "李四", "unrelated"),
        item("invoice.amount", "80000", "invoice"),
    ]
    result = build_affiliation_subject_check(
        "甲运输有限公司", "乙运输有限公司", observations
    )
    assert {e["source_id"] for e in result.check.evidence} == {
        "old-image",
        "new-image",
        "license-a",
        "license-b",
    }
    assert {value.source for value in result.check.values} >= {
        "旧车主体类型",
        "新车主体类型",
        "旧车所有人",
        "新车所有人",
    }


def test_duplicate_matching_license_images_are_insufficient():
    observations = [
        item("business_license.company_name", "甲运输有限公司", source)
        for source in ("license-a", "license-copy")
    ] + [
        item("business_license.legal_representative", "张三", source)
        for source in ("license-a", "license-copy")
    ]
    result = build_affiliation_subject_check("甲运输有限公司", "张三", observations)
    assert result.check.status == "INSUFFICIENT"
    assert result.page_actions == ()
