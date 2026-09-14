import re
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation

# 这些字段来自证件/车辆编号，OCR 常把大小写或空格识别得不稳定。
IDENTIFIER_SUFFIXES = (".vin", ".plate_no", ".certificate_no", ".invoice_no", ".code")
DATE_SUFFIXES = (".date", "_date")
OWNER_SUFFIX_LABELS = re.compile(
    r"(?:统一社会信用代码|社会信用代码|组织机构代码|统一信用代码).*\Z"
)
PARTY_NAME_SUFFIXES = (".owner", ".buyer_name", ".seller_name")
PARTY_PUNCTUATION = re.compile(r"[\s,，。．·•:：;；()（）\[\]【】/／]+")
VIN_AMBIGUITY_HINTS = re.compile(r"(?:易混淆|易混|不确定字符|疑似字符).*\Z", re.IGNORECASE)


def _normalize_vin(text: str) -> str:
    # OCR 提示是元数据，不是 VIN 本身；只保留规范值参与比较。
    return "".join(
        character
        for character in VIN_AMBIGUITY_HINTS.sub("", text).upper()
        if character.isalnum()
    )


def _normalize_invoice_number(text: str) -> str:
    text = re.sub(r"^(?:数电号码|发票号码|发票代码)[:：]?", "", text)
    return "".join(character for character in text.upper() if character.isalnum())


def _normalize_vehicle_type(text: str) -> str:
    value = re.sub(r"\s+", "", text)
    # 行驶证/登记证通常给出完整车型，页面只保存业务大类。只有语义明确
    # 落入同一大类时才折叠，不能依靠任意子串模糊匹配。
    if "牵引车" in value:
        return "牵引车"
    if any(kind in value for kind in ("载货汽车", "载货车", "货车")):
        return "载货汽车"
    return value


def _normalize_engine_model(text: str) -> str:
    # 仅消除格式差异；I/1、O/0 等字符差异必须保留，交给审核员确认。
    return re.sub(r"[\s\-－]", "", text).upper()


def _normalize_fuel_type(text: str) -> str:
    """Normalize equivalent fuel labels without crossing hybrid/fuel boundaries."""
    value = re.sub(r"\s+", "", text)
    # 混合动力是独立业务语义，不能因为包含“电”就折叠为新能源。
    if any(token in value for token in ("油电混合", "插电混合", "混合动力", "混合燃料")):
        return "混合动力"
    if value in {"电", "纯电", "纯电动", "电动", "新能源", "新能源汽车", "电能"}:
        return "新能源"
    return value


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
    if field_name in {"old_vehicle.vin", "new_vehicle.vin", "page_ocr.new_vehicle_vin"}:
        return _normalize_vin(text)
    if field_name in {"invoice.invoice_no", "invoice.code"}:
        return _normalize_invoice_number(text)
    if field_name == "old_vehicle.type":
        return _normalize_vehicle_type(text)
    if field_name == "old_vehicle.engine_model":
        return _normalize_engine_model(text)
    if field_name == "new_vehicle.fuel_type":
        return _normalize_fuel_type(text)
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
