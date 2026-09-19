"""能力子图的扩展边界。

每个工厂接受共享执行上下文、返回能力结果。**名字保持稳定**，Profile 可以
按名字选择子图而不必改动通用主图；将来某个能力内部要拆成多节点时，直接替换
对应工厂的实现（内部节点可以自由演化，主图只看 `CapabilityResult` 契约）。

当前这 7 个工厂**都还是单节点透传**——它们只是提前占好的接缝，不是已经实现的
领域流程。主图目前调用的是 `build_capability_subgraph` 本身。

新增领域步骤时不要在这里加节点：主图只依赖 `CapabilitySpec` 和 `CapabilityResult`，
子图内部的节点名不对外暴露。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TypeAlias

from app.capabilities.specs import CapabilitySpec, ReviewExecutionContext
from app.models.review import CapabilityResult

from .common import build_capability_subgraph

CapabilityHandler: TypeAlias = Callable[
    [ReviewExecutionContext, CapabilitySpec], Awaitable[CapabilityResult]
]


def build_material_validation_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """材料类型、数量和页码校验的扩展边界。"""
    return build_capability_subgraph(handler)


def build_qr_verification_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """二维码解析、外部访问和字段核验的扩展边界。"""
    return build_capability_subgraph(handler)


def build_policy_evaluation_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """地区政策日期、产地和阈值的扩展边界。"""
    return build_capability_subgraph(handler)


def build_entity_relationship_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """个人、公司、身份证和营业执照关系的扩展边界。"""
    return build_capability_subgraph(handler)


def build_evidence_extraction_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """OCR 与证据规范化的扩展边界。"""
    return build_capability_subgraph(handler)


def build_field_comparison_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """页面字段与材料字段比较的扩展边界。"""
    return build_capability_subgraph(handler)


def build_final_review_subgraph(handler: CapabilityHandler) -> CapabilityHandler:
    """任务汇总与最终复核的扩展边界。"""
    return build_capability_subgraph(handler)


__all__ = [
    "build_capability_subgraph",
    "build_entity_relationship_subgraph",
    "build_evidence_extraction_subgraph",
    "build_field_comparison_subgraph",
    "build_final_review_subgraph",
    "build_material_validation_subgraph",
    "build_policy_evaluation_subgraph",
    "build_qr_verification_subgraph",
]
