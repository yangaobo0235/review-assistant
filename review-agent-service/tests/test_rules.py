from app.models.review import Evidence, FieldStatus
from app.rules.compare import compare_values
from app.rules.normalize import normalize_value


def test_normalize_identifiers_removes_spaces_and_uppercases() -> None:
    assert normalize_value("old_vehicle.vin", " lf ws rx9 7l " ) == "LFWSRX97L"


def test_normalize_owner_keeps_chinese_text_but_removes_spaces() -> None:
    assert normalize_value("old_vehicle.owner", " 李  明 ") == "李明"


def test_normalize_owner_removes_appended_unified_social_credit_code() -> None:
    value = "丹阳市双跃危险货物运输有限公司/统一社会信用代码/91321181730111164"

    assert normalize_value("old_vehicle.owner", value) == "丹阳市双跃危险货物运输有限公司"


def test_normalize_owner_removes_credit_code_with_colon_separator() -> None:
    value = "丹阳市双跃危险货物运输有限公司：统一社会信用代码：91321181730111164"

    assert normalize_value("new_vehicle.owner", value) == "丹阳市双跃危险货物运输有限公司"


def test_normalizes_transfer_party_names_without_fuzzy_matching() -> None:
    assert normalize_value("transfer.buyer_name", "某某运输（集团） 有限公司") == "某某运输集团有限公司"
    assert normalize_value("transfer.seller_name", "某某运输有限公司") != normalize_value(
        "transfer.seller_name",
        "某某运输有限责任公司",
    )


def test_normalize_invoice_amount_ignores_currency_grouping_and_decimal_zeros() -> None:
    assert normalize_value("invoice.amount", "￥ 152,000") == "152000"
    assert normalize_value("invoice.amount", "152000.00") == "152000"


def test_normalize_business_dates_accepts_page_and_chinese_formats() -> None:
    assert normalize_value("invoice.invoice_date", "2026-07-29") == "2026-07-29"
    assert normalize_value("invoice.invoice_date", "2026年07月29日") == "2026-07-29"


def test_compare_values_returns_match_for_equivalent_values() -> None:
    result = compare_values("old_vehicle.vin", "ab c", "ABC", [Evidence(source="test")])
    assert result.status is FieldStatus.MATCH


def test_compare_equivalent_amount_displays_image_value_like_page() -> None:
    result = compare_values("invoice.amount", "152000.00", "￥ 152,000", [])

    assert result.status is FieldStatus.MATCH
    assert result.left_value == "￥ 152,000"
    assert result.right_value == "￥ 152,000"


def test_compare_values_returns_conflict_for_different_values() -> None:
    result = compare_values("old_vehicle.owner", "张三", "李四", [])
    assert result.status is FieldStatus.CONFLICT


def test_compare_values_requires_review_when_value_is_missing() -> None:
    result = compare_values("old_vehicle.owner", None, "李四", [])
    assert result.status is FieldStatus.REVIEW_REQUIRED
    assert result.message == "图片识别值缺失，页面字段已采集"


def test_compare_values_explains_when_page_value_is_missing() -> None:
    result = compare_values("old_vehicle.owner", "李四", None, [])
    assert result.status is FieldStatus.REVIEW_REQUIRED
    assert result.message == "页面字段缺失，图片识别值已采集"


def test_compare_values_explains_when_both_values_are_missing() -> None:
    result = compare_values("old_vehicle.owner", None, None, [])
    assert result.message == "页面字段和图片识别值均缺失"
