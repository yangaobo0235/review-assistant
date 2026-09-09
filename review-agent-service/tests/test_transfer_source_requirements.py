from app.models.review import FieldComparison, FieldObservation, FieldStatus
from app.rules.transfer_sources import (
    enforce_transfer_source_requirements,
    filter_transfer_observations,
)


def observation(source_type: str, document_type: str | None, value: str, group_order: int | None = None):
    return FieldObservation(
        field="transfer.vin",
        source_type=source_type,
        source_id=f"{source_type}-{group_order or 'page'}",
        document_type=document_type,
        group_order=group_order,
        value=value,
    )


def test_transfer_vin_keeps_page_invoice_and_registration_page_two_only():
    result = filter_transfer_observations(
        "transfer.vin",
        [
            observation("page", None, "PAGE"),
            observation("image", "invoice", "INVOICE"),
            observation("image", "registration_certificate", "REG-1", 1),
            observation("image", "registration_certificate", "REG-2", 2),
            observation("image", "registration_certificate", "REG-3", 3),
            observation("image", "registration_certificate", "REG-4", 4),
        ],
    )
    assert [item.value for item in result] == ["PAGE", "INVOICE", "REG-2"]


def test_registration_covered_pages_override_upload_order_for_vin():
    reg = observation("image", "registration_certificate", "REG-2", 4)
    covered = FieldObservation(
        field="transfer.registration.covered_pages",
        source_type="image",
        source_id=reg.source_id,
        document_type="registration_certificate",
        group_order=4,
        value=[2],
    )
    result = filter_transfer_observations("transfer.vin", [reg, covered])
    assert reg in result


def test_transfer_source_filter_does_not_change_other_fields():
    item = FieldObservation(
        field="transfer.seller_name",
        source_type="image",
        source_id="reg-3",
        document_type="registration_certificate",
        group_order=3,
        value="SELLER",
    )
    assert filter_transfer_observations("transfer.seller_name", [item]) == [item]


def test_registration_page_one_does_not_satisfy_vin_page_two_requirement():
    observations = [
        observation("page", None, "VIN"),
        observation("image", "invoice", "VIN"),
        observation("image", "registration_certificate", "VIN", 1),
    ]
    comparison = FieldComparison(
        field="transfer.vin",
        left_value="VIN",
        right_value="VIN",
        status=FieldStatus.MATCH,
    )
    result = enforce_transfer_source_requirements(comparison, observations)
    assert result.status is FieldStatus.REVIEW_REQUIRED
    assert result.message == "缺少必需来源：登记证第2页"


def test_uncertain_source_with_missing_document_type_is_ignored():
    comparison = FieldComparison(
        field="transfer.vin",
        left_value="VIN",
        right_value="VIN",
        status=FieldStatus.MATCH,
    )
    observations = [
        FieldObservation(
            field="transfer.uncertain_fields",
            source_type="page",
            source_id="page",
            document_type=None,
            value=["vehicle.vin"],
        ),
        observation("page", None, "VIN"),
        observation("image", "invoice", "VIN"),
    ]

    result = enforce_transfer_source_requirements(comparison, observations)

    assert result.status is FieldStatus.REVIEW_REQUIRED
    assert result.message == "缺少必需来源：登记证第2页"
