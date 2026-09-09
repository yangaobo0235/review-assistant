from app.models.review import FieldComparison, FieldObservation, FieldStatus

TRANSFER_SOURCE_REQUIREMENTS = {
    "transfer.plate_no": frozenset({"page", "invoice"}),
    "transfer.vin": frozenset({"page", "invoice", "registration_certificate"}),
    "transfer.buyer_name": frozenset({"page", "invoice"}),
    "transfer.seller_name": frozenset({"page", "invoice"}),
    "transfer.invoice_date": frozenset({"page", "invoice"}),
}

SOURCE_LABELS = {
    "page": "申请页面",
    "invoice": "二手车发票",
    "registration_certificate": "登记证第2页",
}


def filter_transfer_observations(
    field_name: str,
    observations: list[FieldObservation],
) -> list[FieldObservation]:
    """Keep only authoritative material sources for a transfer field.

    Registration-certificate VINs are page-scoped: only the second page is
    relevant to the transfer voucher comparison.  Page observations remain
    authoritative and all non-VIN fields keep their existing source set.
    """
    if field_name != "transfer.vin":
        return observations
    page_coverage_by_source: dict[str, set[int]] = {}
    for observation in observations:
        if (
            observation.document_type == "registration_certificate"
            and observation.field == "transfer.registration.covered_pages"
            and isinstance(observation.value, list)
        ):
            page_coverage_by_source[observation.source_id] = {
                page for page in observation.value if isinstance(page, int)
            }
    filtered: list[FieldObservation] = []
    for observation in observations:
        if observation.source_type == "page" and observation.field == field_name:
            filtered.append(observation)
            continue
        if observation.document_type == "invoice":
            filtered.append(observation)
            continue
        if observation.document_type == "registration_certificate":
            covered_pages = page_coverage_by_source.get(observation.source_id)
            if (covered_pages is not None and 2 in covered_pages) or (
                covered_pages is None and observation.group_order == 2
            ):
                filtered.append(observation)
    return filtered

UNCERTAIN_FIELD_ROUTES = {
    "invoice": {
        "vehicle.plate_no": "transfer.plate_no",
        "vehicle.vin": "transfer.vin",
        "invoice.buyer_name": "transfer.buyer_name",
        "invoice.seller_name": "transfer.seller_name",
        "invoice.invoice_date": "transfer.invoice_date",
    },
    "registration_certificate": {
        "vehicle.vin": "transfer.vin",
    },
}


def _source_key(observation: FieldObservation) -> str | None:
    if observation.source_type == "page":
        return "page"
    if observation.source_type == "image":
        return observation.document_type
    return None


def enforce_transfer_source_requirements(
    comparison: FieldComparison,
    observations: list[FieldObservation],
) -> FieldComparison:
    if comparison.status is FieldStatus.CONFLICT:
        return comparison
    relevant_observations = filter_transfer_observations(
        comparison.field,
        observations,
    )
    uncertain_sources: set[str] = set()
    for observation in relevant_observations:
        document_type = observation.document_type
        if (
            document_type is None
            or observation.field != "transfer.uncertain_fields"
            or not isinstance(observation.value, list)
        ):
            continue
        if any(
            UNCERTAIN_FIELD_ROUTES.get(document_type, {}).get(str(field))
            == comparison.field
            for field in observation.value
        ):
            uncertain_sources.add(document_type)
    if uncertain_sources:
        labels = "、".join(
            SOURCE_LABELS.get(source, source) for source in sorted(uncertain_sources)
        )
        return comparison.model_copy(
            update={
                "status": FieldStatus.REVIEW_REQUIRED,
                "message": f"{labels}字段识别不确定",
            }
        )
    required = TRANSFER_SOURCE_REQUIREMENTS.get(comparison.field, frozenset())
    present = {
        source
        for observation in relevant_observations
        if observation.field == comparison.field
        if (source := _source_key(observation)) is not None
        if observation.value not in (None, "")
    }
    missing = required - present
    if not missing:
        return comparison
    missing_labels = "、".join(SOURCE_LABELS[source] for source in sorted(missing))
    return comparison.model_copy(
        update={
            "status": FieldStatus.REVIEW_REQUIRED,
            "message": f"缺少必需来源：{missing_labels}",
        }
    )
