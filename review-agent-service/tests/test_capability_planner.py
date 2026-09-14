from app.agent.planner import plan_capabilities
from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO, VEHICLE_SOURCE_DEFAULT


def test_configured_profile_plans_declared_capabilities_only():
    ids = {item.capability_id for item in plan_capabilities(SCRAP_REPLACEMENT_QINGDAO)}
    assert ids == {
        "scrap_certificate_qr",
        "qingdao_replacement_policy",
        "affiliation_subject",
    }


def test_unconfigured_profile_is_explicitly_marked():
    plan = plan_capabilities(VEHICLE_SOURCE_DEFAULT)
    assert [(item.capability_id, item.status) for item in plan] == [("profile", "NOT_CONFIGURED")]

