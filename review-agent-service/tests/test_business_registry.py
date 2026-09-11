import pytest

from app.businesses.registry import BusinessProfileNotFound, build_business_registry
from app.models.review import BusinessType, Region, ReviewRequest


def test_registry_resolves_scrap_profile_by_identity() -> None:
    profile = build_business_registry().resolve(
        BusinessType.SCRAP_REPLACEMENT,
        Region.QINGDAO,
        "1.0",
    )

    assert profile.business_type is BusinessType.SCRAP_REPLACEMENT
    assert "old_vehicle.vin" in profile.required_fields
    assert profile.rules_configured is True
    assert [item.check_id for item in profile.external_checks] == ["scrap_certificate_qr"]
    assert profile.rule_groups == (
        "qingdao_replacement_policy",
        "affiliation_subject",
    )
    assert profile.page_actions == ("fill_affiliation_fields",)


def test_registry_resolves_changchun_profiles_without_fallback() -> None:
    registry = build_business_registry()

    replacement = registry.resolve(
        BusinessType.SCRAP_REPLACEMENT,
        Region.CHANGCHUN,
        "1.0",
    )
    consistency = registry.resolve(
        BusinessType.CONSISTENCY,
        Region.CHANGCHUN,
        "1.0",
    )

    assert replacement.region is Region.CHANGCHUN
    assert replacement.rule_groups[0] == "changchun_replacement_policy"
    assert consistency.region is Region.CHANGCHUN
    assert consistency.rules_configured is False


def test_registry_keeps_unconfigured_businesses_out_of_scrap_rules() -> None:
    profile = build_business_registry().resolve(
        BusinessType.VEHICLE_SOURCE,
        Region.DEFAULT,
        "1.0",
    )

    assert profile.required_fields == ()
    assert profile.rules_configured is False


def test_registry_uses_only_explicit_default_region_fallback() -> None:
    profile = build_business_registry().resolve(
        BusinessType.VEHICLE_SOURCE,
        Region.QINGDAO,
        "1.0",
    )

    assert profile.region is Region.DEFAULT

    with pytest.raises(BusinessProfileNotFound):
        build_business_registry().resolve(
            BusinessType.SCRAP_REPLACEMENT,
            Region.DEFAULT,
            "1.0",
        )


def test_region_scoped_request_without_region_cannot_resolve_a_scrap_profile() -> None:
    request = ReviewRequest(page_url="https://example.test/scrap-replace")

    assert request.region is Region.DEFAULT
    with pytest.raises(BusinessProfileNotFound):
        build_business_registry().resolve(
            request.business_type,
            request.region,
            request.profile_version,
        )


def test_registry_rejects_unknown_profile_version() -> None:
    with pytest.raises(BusinessProfileNotFound):
        build_business_registry().resolve(
            BusinessType.CONSISTENCY,
            Region.QINGDAO,
            "9.9",
        )


def test_registry_enables_isolated_transfer_profile_without_qr() -> None:
    profile = build_business_registry().resolve(
        BusinessType.TRANSFER,
        Region.DEFAULT,
        "1.0",
    )

    assert profile.rules_configured is True
    assert profile.required_fields == (
        "transfer.plate_no",
        "transfer.vin",
        "transfer.buyer_name",
        "transfer.seller_name",
        "transfer.invoice_date",
    )
    assert profile.external_checks == ()
    assert profile.rule_groups == ("transfer_registration",)
    assert profile.page_actions == ()
    assert [section.id for section in profile.sections] == ["transfer"]
