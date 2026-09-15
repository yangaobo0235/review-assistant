"""Reusable capability subgraph boundaries.

Each factory accepts a shared execution context and returns a capability
result. Keeping these names stable lets a profile select a subgraph without
changing the generic review graph.
"""

from .common import build_capability_subgraph
from .entity_relationship import build_entity_relationship_subgraph
from .evidence_extraction import build_evidence_extraction_subgraph
from .field_comparison import build_field_comparison_subgraph
from .final_review import build_final_review_subgraph
from .material_validation import build_material_validation_subgraph
from .policy_evaluation import build_policy_evaluation_subgraph
from .qr_verification import build_qr_verification_subgraph

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
