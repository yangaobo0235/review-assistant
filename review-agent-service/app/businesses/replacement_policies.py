"""报废置换地区政策配置。"""

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


QINGDAO_REPLACEMENT_POLICY = ReplacementPolicy(
    policy_id="scrap_replacement_qingdao",
    region=Region.QINGDAO,
    version="1.0",
    invoice_date_from=date(2026, 9, 1),
    invoice_date_to=date(2026, 9, 30),
    disposal_deadline=date(2026, 10, 31),
    allowed_origins=("青岛", "青岛市", "山东省青岛市"),
)

CHANGCHUN_REPLACEMENT_POLICY = ReplacementPolicy(
    policy_id="scrap_replacement_changchun",
    region=Region.CHANGCHUN,
    version="1.0",
    invoice_date_from=date(2026, 7, 1),
    invoice_date_to=date(2026, 9, 30),
    disposal_deadline=date(2026, 12, 31),
    allowed_origins=("长春", "长春市", "吉林省长春市"),
    origin_keywords=("长春",),
)


REPLACEMENT_POLICIES = {
    (policy.region, policy.version): policy
    for policy in (QINGDAO_REPLACEMENT_POLICY, CHANGCHUN_REPLACEMENT_POLICY)
}
