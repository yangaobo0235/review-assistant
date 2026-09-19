"""在原始展示文本上生成差异区间；规范化只决定是否存在业务差异。"""

from difflib import SequenceMatcher

from app.fields.normalize import normalize_value
from app.models.evidence import DifferenceRange


def value_differences(field: str, page: object, value: object) -> list[DifferenceRange]:
    if page is None or value is None:
        return []
    if normalize_value(field, page) == normalize_value(field, value):
        return []
    original, recognized = str(page), str(value)
    return [
        DifferenceRange(
            kind={"replace": "REPLACE", "insert": "EXTRA", "delete": "MISSING"}[tag],
            start=j1, end=j2, page_start=i1, page_end=i2,
            page_text=original[i1:i2],
        )
        for tag, i1, i2, j1, j2 in SequenceMatcher(
            None, original, recognized, autojunk=False
        ).get_opcodes()
        if tag != "equal"
    ]
