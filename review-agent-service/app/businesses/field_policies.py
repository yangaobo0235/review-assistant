"""报废置换字段的动态证据来源策略。

策略只描述允许的来源和比较语义，不把某一张材料当成所有申请都必须存在的
“主要来源”。运行时仍以实际识别到的有效证据为准。

字段的裁决方式有两种，都是声明式的：

- `mode="SYSTEM"`：以页面填写值为准，材料不参与比对（如手机号、主体类型）。
- `authority=(...)`：声明证据权威链，由 `aggregate.aggregate_by_authority`
  执行。链首来源是唯一比较基准，其余来源按各自的 `match` 窗口与基准比对；
  链首缺失时降级为人工复核，不让位给下一条来源，也不退化成投票。

声明本身位于业务扩展包 `app.businesses.packs`；本模块只把它转成运行时结构。
新增一个需要权威关系的字段时，在扩展包里加一条 `authority` 即可，不需要
再写专用的裁决函数——`old_vehicle.vin` 原先就是这样一个约 130 行的函数。
"""

from dataclasses import dataclass, replace

from app.businesses.packs import SCRAP_REPLACEMENT_PACK as _PACK
from app.businesses.packs.model import (
    AuthorityRule,
    EvidenceMode,
)


@dataclass(frozen=True)
class FieldEvidencePolicy:
    field: str
    mode: EvidenceMode
    allowed_document_types: tuple[str, ...] = ()
    allow_single_evidence: bool = True
    normalizer: str = "default"
    authority: tuple[AuthorityRule, ...] = ()


def _build_policies(pack) -> dict[str, FieldEvidencePolicy]:
    policies = {
        item.key: FieldEvidencePolicy(
            field=item.key,
            mode=item.mode,
            allowed_document_types=item.sources,
            allow_single_evidence=item.allow_single_evidence,
            normalizer=item.normalizer,
            authority=item.authority,
        )
        for item in pack.fields
        if item.mode is not None
    }
    # 共用证据策略的页面字段（如 OCR 车架号）在材料字段之后克隆，避免依赖声明顺序。
    for item in pack.fields:
        if item.material_field is not None:
            policies[item.key] = replace(policies[item.material_field], field=item.key)
    return policies


FIELD_EVIDENCE_POLICIES = _build_policies(_PACK)

# 页面控件与材料字段共用同一份证据策略。
MATERIAL_FIELD_BY_PAGE_FIELD = {
    item.key: item.material_field
    for item in _PACK.fields
    if item.material_field is not None
}


def field_policy(field: str) -> FieldEvidencePolicy | None:
    return FIELD_EVIDENCE_POLICIES.get(field)



def filter_allowed_observations(field: str, observations):
    """按实际材料类型过滤证据；未知类型不冒充允许来源。"""
    policy = field_policy(field)
    if policy is None or policy.mode in {"SYSTEM", "DERIVED", "PAGE_AUXILIARY"}:
        return list(observations)
    allowed = set(policy.allowed_document_types)
    result = []
    for item in observations:
        if item.source_type == "page" or item.source_type in {"image", "qr_page"} and (not item.document_type or item.document_type in allowed):
            result.append(item)
    return result
