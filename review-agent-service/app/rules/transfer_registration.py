from dataclasses import dataclass
from datetime import date
from typing import Any

from app.models.review import FieldObservation
from app.rules.normalize import normalize_value


@dataclass(frozen=True)
class TransferRecord:
    owner: str
    registration_date: date | None
    page: int
    order: int


@dataclass(frozen=True)
class RegistrationSummary:
    covered_pages: frozenset[int]
    owners: tuple[str, ...]
    records: tuple[TransferRecord, ...]
    latest_owner: str | None
    complete: bool
    seller_complete: bool
    latest_owner_complete: bool
    uncertain: bool
    uncertain_fields: frozenset[str]


def summarize_registration(observations: list[FieldObservation]) -> RegistrationSummary:
    pages: set[int] = set()
    initial_owners: list[str] = []
    records_by_position: dict[tuple[int, int], TransferRecord] = {}
    conflicting_positions: set[tuple[int, int]] = set()
    uncertain = False
    uncertain_fields: set[str] = set()

    for observation in observations:
        if (
            observation.business_scope != "transfer"
            or observation.document_type != "registration_certificate"
        ):
            continue
        value: Any = observation.value
        if observation.field == "transfer.registration.covered_pages":
            if not isinstance(value, list):
                uncertain = True
                continue
            for page in value:
                if isinstance(page, int) and 1 <= page <= 4:
                    pages.add(page)
                else:
                    uncertain = True
        elif observation.field == "transfer.registration.initial_owner":
            if isinstance(value, str) and value.strip():
                initial_owners.append(value.strip())
            else:
                uncertain = True
        elif observation.field == "transfer.registration.transfer_records":
            if not isinstance(value, list):
                uncertain = True
                continue
            for raw in value:
                if not isinstance(raw, dict):
                    uncertain = True
                    continue
                owner = raw.get("owner")
                page = raw.get("page")
                order = raw.get("order")
                raw_date = raw.get("date")
                if (
                    not isinstance(owner, str)
                    or not owner.strip()
                    or not isinstance(page, int)
                    or not 1 <= page <= 4
                    or not isinstance(order, int)
                    or order < 1
                ):
                    uncertain = True
                    continue
                registration_date = None
                if raw_date not in (None, ""):
                    try:
                        registration_date = date.fromisoformat(str(raw_date)[:10])
                    except ValueError:
                        uncertain = True
                position = (page, order)
                if position in conflicting_positions:
                    continue
                record = TransferRecord(owner.strip(), registration_date, page, order)
                existing = records_by_position.get(position)
                if existing is None:
                    records_by_position[position] = record
                    continue
                same_owner = normalize_value(
                    "transfer.seller_name", existing.owner
                ) == normalize_value("transfer.seller_name", record.owner)
                if (
                    same_owner
                    and existing.registration_date == record.registration_date
                ):
                    continue
                records_by_position.pop(position, None)
                conflicting_positions.add(position)
                uncertain = True
        elif observation.field == "transfer.uncertain_fields" and isinstance(
            value, list
        ):
            uncertain_fields.update(str(field) for field in value if field)

    if 1 in pages and not initial_owners:
        uncertain = True
    if (
        len(
            {normalize_value("transfer.seller_name", owner) for owner in initial_owners}
        )
        > 1
    ):
        uncertain = True

    records = tuple(
        sorted(
            records_by_position.values(),
            key=lambda item: (
                item.page,
                item.order,
                item.registration_date or date.min,
            ),
        )
    )
    ordered_owners: list[str] = []
    seen_owners: set[str | None] = set()
    for owner in [*initial_owners, *(item.owner for item in records)]:
        normalized = normalize_value("transfer.seller_name", owner)
        if normalized in seen_owners:
            continue
        seen_owners.add(normalized)
        ordered_owners.append(owner)

    pages_complete = pages == {1, 2, 3, 4}
    seller_uncertain = bool(
        uncertain_fields
        & {
            "registration.covered_pages",
            "registration.initial_owner",
            "registration.transfer_records",
        }
    )
    latest_owner_uncertain = bool(
        uncertain_fields
        & {"registration.covered_pages", "registration.transfer_records"}
    )
    seller_complete = pages_complete and not uncertain and not seller_uncertain
    latest_owner_complete = (
        pages_complete and not uncertain and not latest_owner_uncertain
    )
    complete = seller_complete
    return RegistrationSummary(
        covered_pages=frozenset(pages),
        owners=tuple(ordered_owners),
        records=records,
        latest_owner=records[-1].owner if latest_owner_complete and records else None,
        complete=complete,
        seller_complete=seller_complete,
        latest_owner_complete=latest_owner_complete,
        uncertain=uncertain or bool(uncertain_fields),
        uncertain_fields=frozenset(uncertain_fields),
    )
