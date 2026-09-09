import re
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation

# 这些字段来自证件/车辆编号，OCR 常把大小写或空格识别得不稳定。
IDENTIFIER_SUFFIXES = (".vin", ".plate_no", ".certificate_no", ".invoice_no")
DATE_SUFFIXES = (".date", "_date")
OWNER_SUFFIX_LABELS = re.compile(
    r"(?:统一社会信用代码|社会信用代码|组织机构代码|统一信用代码).*\Z"
)
PARTY_NAME_SUFFIXES = (".owner", ".buyer_name", ".seller_name")
PARTY_PUNCTUATION = re.compile(r"[\s,，。．·•:：;；()（）\[\]【】/／]+")


def _normalize_amount(text: str) -> str:
    cleaned = re.sub(r"[¥￥\u00a5,，元]", "", text, flags=re.IGNORECASE)
    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return text
    normalized = format(amount.normalize(), "f")
    return "0" if normalized in {"-0", "-0.0"} else normalized


def _normalize_date(text: str) -> str:
    match = re.fullmatch(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?", text)
    if not match:
        return text
    try:
        parsed = date(*(int(part) for part in match.groups()))
    except ValueError:
        return text
    return parsed.isoformat()


def normalize_value(field_name: str, value: object) -> str | None:
    """把不同来源的字段转换成可比较、但不丢失业务差异的形式。"""
    if value is None:
        return None
    text = unicodedata.normalize("NFKC", str(value)).strip()
    if field_name.endswith(PARTY_NAME_SUFFIXES):
        text = OWNER_SUFFIX_LABELS.sub("", text)
        text = PARTY_PUNCTUATION.sub("", text)
    text = re.sub(r"\s+", "", text)
    if field_name == "invoice.amount":
        return _normalize_amount(text)
    if field_name.endswith(DATE_SUFFIXES):
        return _normalize_date(text)
    if field_name.endswith(IDENTIFIER_SUFFIXES):
        return text.upper()
    return text


def format_like_page(field_name: str, image_value: object, page_value: object) -> object:
    """Use the page representation only when both values are semantically equal."""
    if page_value is None:
        return image_value
    if normalize_value(field_name, image_value) == normalize_value(field_name, page_value):
        return page_value
    return image_value
