"""地区置换政策的数据结构。

政策数据本身位于各业务的扩展包（`app.businesses.packs`）；本模块只定义结构，
供扩展包声明和规则执行使用。
"""

from dataclasses import dataclass
from datetime import date

from app.models.review import Region


@dataclass(frozen=True)
class ReplacementPolicy:
    policy_id: str
    region: Region
    version: str
    invoice_date_from: date
    invoice_date_to: date
    disposal_deadline: date
    allowed_origins: tuple[str, ...] = ()
    origin_keywords: tuple[str, ...] = ()
