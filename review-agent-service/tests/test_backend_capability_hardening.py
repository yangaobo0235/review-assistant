from dataclasses import replace

import pytest

from app.agent.models import (
    AgentBatchResult,
    MaterialCompletenessIssue,
    MaterialCompletenessReport,
    RecognizedDocument,
    ReviewCheck,
)
from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO, TRANSFER_DEFAULT
from app.businesses.registry import BusinessRegistry
from app.models.review import FieldObservation, ImageInput, ReviewRequest
from app.rules.business_rule_registry import BusinessRuleRegistry
from app.rules.capabilities import (
    ExternalCheckSpec,
    ReviewExecutionContext,
    RuleExecutionResult,
)
from app.rules.final_advice import build_final_advice
from app.services.review import ReviewService


def request_for(profile):
    return ReviewRequest(
        page_url="https://example.test/review",
        business_type=profile.business_type,
        region=profile.region,
    )


def test_removed_qr_switch_cannot_be_configured_as_a_second_source_of_truth():
    with pytest.raises(TypeError):
        replace(SCRAP_REPLACEMENT_QINGDAO, qr_required=True)
    with pytest.raises(TypeError):
        build_final_advice([], [], [], [], [], [], qr_required=True)


@pytest.mark.parametrize(
    "mode,expected", [("REQUIRED", ["INSUFFICIENT"]), ("WHEN_PRESENT", [])]
)
@pytest.mark.asyncio
async def test_external_mode_controls_missing_material(mode, expected):
    profile = replace(
        SCRAP_REPLACEMENT_QINGDAO,
        external_checks=(ExternalCheckSpec("scrap_certificate_qr", mode),),
    )
    service = ReviewService(registry=BusinessRegistry((profile,)))
    response, _ = await service.workflow.run(request_for(profile), profile)
    assert [
        step.result_status
        for step in response.review_steps
        if step.category == "EXTERNAL"
    ] == expected
    assert [
        finding.status
        for finding in response.agent_advice.findings
        if finding.label == "二维码官网核验"
    ] == expected


@pytest.mark.parametrize(
    "change",
    [
        {"rule_groups": ("missing",)},
        {"external_checks": (ExternalCheckSpec("missing", "REQUIRED"),)},
        {"page_actions": ("missing",)},
        {"replacement_policy": None},
    ],
)
def test_invalid_profile_configuration_fails_service_construction(change):
    profile = replace(SCRAP_REPLACEMENT_QINGDAO, **change)
    with pytest.raises((ValueError, LookupError)):
        ReviewService(registry=BusinessRegistry((profile,)))


def test_invalid_external_mode_is_rejected():
    with pytest.raises(ValueError):
        ExternalCheckSpec("scrap_certificate_qr", "SOMETIMES")


def test_capability_registries_cannot_be_modified_after_startup():
    service = ReviewService()
    for registry in (service.workflow.external_checks, service.workflow.business_rules):
        with pytest.raises(TypeError):
            registry._handlers["unexpected"] = lambda _: None


def test_partial_response_never_runs_retired_owner_or_same_year_checks():
    service = ReviewService()
    response = service._build_response(
        request_for(SCRAP_REPLACEMENT_QINGDAO), AgentBatchResult(), include_tools=False
    )
    assert response.cross_checks == []
    assert not any(
        item.check_id.startswith(("CROSS-OWNER", "CROSS-DATE", "QR-"))
        for item in response.agent_advice.findings
    )


def test_duplicate_checks_count_once_and_keep_failure_over_match():
    duplicate = ReviewCheck(
        check_id="DUP", label="重复检查", status="CONFLICT", reason="证据冲突"
    )
    _, advice = build_final_advice(
        [],
        [duplicate, duplicate, duplicate.model_copy(update={"status": "MATCH"})],
        [],
        [],
        [],
        [],
    )
    assert [item.check_id for item in advice.findings] == ["DUP"]
    assert advice.summary == "发现 1 项需要审核人员确认"


@pytest.mark.parametrize(
    "profile",
    [
        replace(
            SCRAP_REPLACEMENT_QINGDAO,
            required_fields=(),
            material_policy=None,
            rule_groups=(),
            page_actions=(),
            external_checks=(),
            replacement_policy=None,
        ),
        TRANSFER_DEFAULT,
    ],
)
@pytest.mark.asyncio
async def test_profiles_without_capabilities_do_not_gain_scrap_steps(
    profile, monkeypatch
):
    service = ReviewService(registry=BusinessRegistry((profile,)))

    async def extract(*args):
        return AgentBatchResult(limitations=["图片识别超时"])

    monkeypatch.setattr(service, "_extract_documents", extract)
    response, _ = await service.workflow.run(request_for(profile), profile)
    assert response.qr_checks == []
    assert response.page_fill_intent == []
    assert not any(
        item.check_id.startswith(("POLICY", "AFFILIATION", "QR"))
        for item in response.cross_checks + response.agent_advice.findings
    )
    assert not any(step.category == "EXTERNAL" for step in response.review_steps)
    assert any(step.reason == "图片识别超时" for step in response.review_steps)
    assert all(
        "." not in step.label
        for step in response.review_steps
        if step.category == "FIELD"
    )


@pytest.mark.parametrize(
    "uncertain,expected", [(True, "INSUFFICIENT"), (False, "MATCH")]
)
@pytest.mark.asyncio
async def test_full_graph_marks_uncertain_representative_insufficient_and_keeps_progress_business_free(
    monkeypatch, uncertain, expected
):
    profile = replace(SCRAP_REPLACEMENT_QINGDAO, external_checks=())
    observations = [
        FieldObservation(
            field=field,
            value=value,
            source_type="image",
            source_id=source,
            image_id=source,
            document_type=document,
            business_scope=scope,
        )
        for field, value, source, document, scope in [
            (
                "old_vehicle.owner",
                "甲有限公司",
                "old",
                "vehicle_license",
                "old_vehicle",
            ),
            (
                "new_vehicle.owner",
                "乙有限公司",
                "new",
                "vehicle_license",
                "new_vehicle",
            ),
            ("new_vehicle.vin", "VIN1", "new", "vehicle_license", "new_vehicle"),
            (
                "business_license.company_name",
                "甲有限公司",
                "a",
                "business_license",
                "unknown",
            ),
            (
                "business_license.legal_representative",
                "张三",
                "a",
                "business_license",
                "unknown",
            ),
            (
                "business_license.company_name",
                "乙有限公司",
                "b",
                "business_license",
                "unknown",
            ),
            (
                "business_license.legal_representative",
                "张三",
                "b",
                "business_license",
                "unknown",
            ),
            ("new_vehicle.origin", "长春市", "invoice", "invoice", "new_vehicle"),
        ]
    ]
    batch = AgentBatchResult(
        observations=observations,
        recognized_documents=[
            RecognizedDocument(
                target_id="a",
                document_type="business_license",
                uncertain_fields=["business_license.legal_representative"],
            ),
            RecognizedDocument(
                target_id="invoice",
                document_type="invoice",
                business_scope="new_vehicle",
                uncertain_fields=["new_vehicle.origin"],
            ),
        ]
        if uncertain
        else [],
    )
    service = ReviewService(registry=BusinessRegistry((profile,)))

    async def extract(request, callback, *args):
        await callback(batch)
        return batch

    monkeypatch.setattr(service, "_extract_documents", extract)
    request = request_for(profile).model_copy(
        update={
            "page_fields": {
                "old_vehicle.owner": "甲有限公司",
                "new_vehicle.owner": "乙有限公司",
                "new_vehicle.vin": "VIN1",
                "application.owner_type": "公司",
                "application.customer_name": "乙有限公司",
                "page_ocr.new_vehicle_vin": "VIN1",
            }
        }
    )
    progress = []
    response = await service.assist_async(
        request, lambda response, _: progress.append(response)
    )
    assert all(item.cross_checks == [] for item in progress[:-1])
    checks = {item.check_id: item for item in response.cross_checks}
    assert checks["AFFILIATION-SUBJECT-001"].status == expected
    # 青岛按配置核验产地；该样例使用的产地不是青岛，因此应进入人工处理。
    assert checks["POLICY-NEW-ORIGIN"].status == ("INSUFFICIENT" if uncertain else "CONFLICT")
    assert bool(response.page_fill_intent) == (not uncertain)
    subject_step = next(
        step for step in response.review_steps if "AFFILIATION-SUBJECT" in step.step_id
    )
    assert {e.source_id for e in subject_step.evidence} >= {"old", "new", "a", "b"}


@pytest.mark.asyncio
async def test_plain_external_review_check_survives_entire_graph_without_qr_assumptions():
    profile = replace(
        SCRAP_REPLACEMENT_QINGDAO,
        external_checks=(ExternalCheckSpec("custom", "REQUIRED"),),
        rule_groups=(),
        material_policy=None,
        required_fields=(),
        page_actions=(),
    )

    async def handler(context, spec):
        return (
            ReviewCheck(
                check_id="CUSTOM-1",
                label="外部凭证核验",
                status="INSUFFICIENT",
                reason="外部凭证缺失",
            ),
        )

    service = ReviewService(
        registry=BusinessRegistry((profile,)),
        external_check_handlers={"custom": handler},
    )
    response, _ = await service.workflow.run(request_for(profile), profile)
    assert response.qr_checks == []
    assert [
        (step.label, step.result_status)
        for step in response.review_steps
        if step.category == "EXTERNAL"
    ] == [("外部凭证核验", "INSUFFICIENT")]
    assert [
        item.check_id
        for item in response.agent_advice.findings
        if item.label == "外部凭证核验"
    ] == ["CUSTOM-1"]


def test_duplicate_rule_groups_and_ids_produce_single_check():
    check = ReviewCheck(check_id="DUP", label="检查", status="MATCH", reason="满足")
    registry = BusinessRuleRegistry(
        {
            "one": lambda _: RuleExecutionResult(checks=(check, check)),
            "two": lambda _: RuleExecutionResult(
                checks=(check.model_copy(update={"status": "CONFLICT"}),)
            ),
        }
    )
    result = registry.execute(
        ("one", "two", "one"),
        ReviewExecutionContext(
            request=request_for(TRANSFER_DEFAULT),
            profile=TRANSFER_DEFAULT,
            batch=AgentBatchResult(),
            observations=(),
        ),
    )
    assert [(check.check_id, check.status) for check in result.checks] == [
        ("DUP", "CONFLICT")
    ]


def test_legacy_cross_document_entry_does_not_run_retired_scrap_rules():
    from app.rules.cross_document import build_cross_document_checks

    assert (
        build_cross_document_checks(SCRAP_REPLACEMENT_QINGDAO.business_type, []) == []
    )
    assert build_cross_document_checks([]) == []


def test_deduplication_preserves_distinct_material_issues_sharing_a_reason_code():
    report = MaterialCompletenessReport(
        phase="EXTRACTED",
        status="INCOMPLETE",
        enforced=True,
        issues=[
            MaterialCompletenessIssue(
                code="MISSING_FIELD_SOURCE",
                field="transfer.vin",
                message="缺少车架号",
                suggested_action="查看原图",
            ),
            MaterialCompletenessIssue(
                code="MISSING_FIELD_SOURCE",
                field="transfer.buyer_name",
                message="缺少买方",
                suggested_action="查看原图",
            ),
        ],
    )
    _, advice = build_final_advice([], [], [], [], [], [], completeness=report)
    assert [check.reason for check in advice.findings] == [
        "缺少车架号；查看原图",
        "缺少买方；查看原图",
    ]


@pytest.mark.parametrize("mode", ["REQUIRED", "WHEN_PRESENT"])
@pytest.mark.asyncio
async def test_external_modes_run_for_recognized_certificate_even_without_extracted_fields(
    mode,
):
    profile = replace(
        SCRAP_REPLACEMENT_QINGDAO,
        external_checks=(ExternalCheckSpec("scrap_certificate_qr", mode),),
    )

    class UnreadableQr:
        def decode_data_url(self, data_url, image_index):
            return []

    service = ReviewService(registry=BusinessRegistry((profile,)), qr=UnreadableQr())
    request = request_for(profile).model_copy(
        update={
            "images": [
                ImageInput(
                    index=3,
                    image_id="scrap",
                    src="https://example.test/image",
                    data_url="data:image/jpeg;base64,AA==",
                )
            ]
        }
    )
    batch = AgentBatchResult(
        recognized_documents=[
            RecognizedDocument(
                target_id="scrap",
                image_index=3,
                document_type="scrap_certificate",
                business_scope="old_vehicle",
            )
        ]
    )
    result = await service.workflow._run_external_checks(
        {"request": request, "profile": profile, "batch": batch}
    )
    assert [(check.image_index, check.message) for check in result["qr_checks"]] == [
        (3, "未识别到二维码")
    ]
