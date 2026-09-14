"""审核字段的单一元数据来源；比较执行仍由 rules.aggregate 负责。"""

from dataclasses import dataclass

from app.rules.review_fields import PRIMARY_REVIEW_FIELDS, SCRAP_PAGE_FIELD_LABELS


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    normalizer: str = "text"
    highlight_mode: str = "CHARACTER"
    writable: bool = False


FIELD_SPECS = tuple(
    FieldSpec(
        key=field,
        label=SCRAP_PAGE_FIELD_LABELS.get(field, field),
        normalizer="vin" if field.endswith(".vin") else "text",
    )
    for field in PRIMARY_REVIEW_FIELDS
)


def field_spec(key: str) -> FieldSpec | None:
    return next((item for item in FIELD_SPECS if item.key == key), None)
