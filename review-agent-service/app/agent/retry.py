"""Deterministic predicates for one bounded semantic retry."""

from app.agent.errors import classify_qwen_error
from app.agent.models import QwenExtraction


def retry_reason_for_error(error: RuntimeError) -> str | None:
    return {
        "invalid_json_syntax": "invalid_json",
        "invalid_response_schema": "invalid_schema",
        "invalid_response_structure": "invalid_structure",
    }.get(classify_qwen_error(error))


def retry_reason_for_extraction(extraction: QwenExtraction, policy: object | None) -> str | None:
    if policy is None:
        return "document_type_mismatch"
    if extraction.document_type != getattr(policy, "document_type", None):
        return "document_type_mismatch"
    if "registration.initial_owner" in extraction.uncertain_fields:
        return "invalid_registration_owner"
    if extraction.confidence is not None and extraction.confidence < 0.70:
        return "low_confidence"
    if not extraction.fields:
        return "empty_supported_fields"
    return None
