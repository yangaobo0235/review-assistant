import asyncio
import logging

import httpx
import pytest

from app.agent.config import QwenConfig
from app.agent.models import QwenClassification, QwenExtraction
from app.agent.qwen_client import QwenClient
from app.agent.service import AgentService
from app.models.review import ImageInput


class FakeQwenClient:
    def __init__(
        self,
        classification: QwenClassification | None = None,
        extraction: QwenExtraction | None = None,
        fail_indices: set[int] | None = None,
    ) -> None:
        self.classification = classification
        self.extraction = extraction
        self.fail_indices = fail_indices or set()
        self.classification_calls: list[int] = []
        self.extraction_calls: list[tuple[int, str]] = []

    async def classify_document(self, image: dict[str, object]) -> QwenClassification:
        self.classification_calls.append(int(image["index"]))
        if self.classification is None:
            raise RuntimeError("缺少分类测试结果")
        return self.classification

    async def extract_fields(
        self, image: dict[str, object], policy: object
    ) -> QwenExtraction:
        image_index = int(image["index"])
        document_type = str(policy.document_type)
        self.extraction_calls.append((image_index, document_type))
        if image_index in self.fail_indices:
            raise RuntimeError("Qwen 调用失败")
        if self.extraction is None:
            raise RuntimeError("缺少提取测试结果")
        return self.extraction


def image(
    index: int = 0,
    category_hint: str = "unknown",
    business_scope: str | None = None,
) -> ImageInput:
    values = {
        "index": index,
        "src": "data:image/jpeg;base64,AA==",
        "data_url": "data:image/jpeg;base64,AA==",
        "category_hint": category_hint,
    }
    if business_scope is not None:
        values["business_scope"] = business_scope
    return ImageInput(**values)


def test_identity_card_is_skipped_without_qwen_call() -> None:
    fake = FakeQwenClient()

    recognized, limitations, confidences = AgentService(fake).extract(
        [image(category_hint="id_card")]
    )

    assert recognized == {}
    assert confidences == []
    assert fake.classification_calls == []
    assert fake.extraction_calls == []
    assert "身份证资料按策略跳过" in limitations


def test_unavailable_identity_card_is_still_reported_as_policy_skip() -> None:
    fake = FakeQwenClient()
    identity_card = ImageInput(
        index=0,
        src="https://example.test/id-card.jpg",
        data_url=None,
        category_hint="id_card",
    )

    _, limitations, _ = AgentService(fake).extract([identity_card])

    assert limitations == ["身份证资料按策略跳过"]


def test_known_invoice_uses_one_extraction_call() -> None:
    fake = FakeQwenClient(
        extraction=QwenExtraction(
            document_type="invoice",
            fields={"invoice.code": "123"},
            confidence=0.9,
        )
    )

    recognized, limitations, confidences = AgentService(fake).extract(
        [image(category_hint="invoice")]
    )

    assert recognized == {"invoice.code": ("123", 0)}
    assert limitations == []
    assert confidences == [0.9]
    assert fake.classification_calls == []
    assert fake.extraction_calls == [(0, "invoice")]


def test_unknown_image_is_classified_then_extracted() -> None:
    fake = FakeQwenClient(
        classification=QwenClassification(document_type="invoice", confidence=0.98),
        extraction=QwenExtraction(
            document_type="invoice",
            fields={"invoice.code": "123"},
            confidence=0.9,
        ),
    )

    recognized, limitations, _ = AgentService(fake).extract(
        [image(business_scope="new_vehicle")]
    )

    assert recognized == {"invoice.code": ("123", 0)}
    assert limitations == []
    assert fake.classification_calls == [0]
    assert fake.extraction_calls == [(0, "invoice")]


def test_unreliable_classification_does_not_extract_fields() -> None:
    classifications = (
        QwenClassification(document_type="invoice", confidence=0.69),
        QwenClassification(document_type="unsupported", confidence=0.99),
    )

    for classification in classifications:
        fake = FakeQwenClient(classification=classification)
        recognized, limitations, _ = AgentService(fake).extract([image()])

        assert recognized == {}
        assert limitations
        assert fake.extraction_calls == []


def test_mismatched_extraction_type_discards_fields() -> None:
    fake = FakeQwenClient(
        extraction=QwenExtraction(
            document_type="old_vehicle",
            fields={"invoice.code": "123"},
        )
    )

    recognized, limitations, _ = AgentService(fake).extract(
        [image(category_hint="invoice")]
    )

    assert recognized == {}
    assert any("资料类型不一致" in item for item in limitations)


def test_non_allowlisted_fields_are_discarded() -> None:
    fake = FakeQwenClient(
        extraction=QwenExtraction(
            document_type="invoice",
            fields={"invoice.code": "123", "old_vehicle.engine_model": "OUT-OF-SCOPE"},
        )
    )

    recognized, _, _ = AgentService(fake).extract([image(category_hint="invoice")])

    assert recognized == {"invoice.code": ("123", 0)}


def test_classified_unknown_image_keeps_resolved_policy_allowlist() -> None:
    fake = FakeQwenClient(
        classification=QwenClassification(document_type="invoice", confidence=0.98),
        extraction=QwenExtraction(
            document_type="invoice",
            fields={"invoice.code": "123", "old_vehicle.engine_model": "OUT-OF-SCOPE"},
        ),
    )

    recognized, _, _ = AgentService(fake).extract(
        [image(category_hint="unknown", business_scope="new_vehicle")]
    )

    assert recognized == {"invoice.code": ("123", 0)}


def test_one_image_failure_does_not_stop_the_next_image() -> None:
    fake = FakeQwenClient(
        extraction=QwenExtraction(
            document_type="invoice",
            fields={"invoice.code": "123"},
        ),
        fail_indices={0},
    )

    recognized, limitations, _ = AgentService(fake).extract(
        [image(0, "invoice"), image(1, "invoice")]
    )

    assert recognized == {"invoice.code": ("123", 1)}
    assert limitations
    assert fake.extraction_calls == [(0, "invoice"), (1, "invoice")]


def test_qwen_failure_is_sanitized_and_logged(caplog: object) -> None:
    class SensitiveFailureClient(FakeQwenClient):
        async def extract_fields(
            self, image: dict[str, object], policy: object
        ) -> QwenExtraction:
            raise RuntimeError("HTTP 400 raw model response VIN=SHOULD-NOT-LEAK")

    with caplog.at_level(logging.WARNING, logger="app.agent.service"):
        _, limitations, _ = AgentService(SensitiveFailureClient()).extract(
            [image(category_hint="invoice")]
        )

    assert limitations == ["图片 0 Qwen 处理失败（qwen_runtime_error）"]
    assert "SHOULD-NOT-LEAK" not in caplog.text
    assert "image=0" in caplog.text
    assert "error_code=qwen_runtime_error" in caplog.text


@pytest.mark.asyncio
async def test_malformed_qwen_api_envelope_is_counted_as_safe_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"{not-json", request=request)

    client = QwenClient(
        QwenConfig("key", "https://dashscope.test/v1", "qwen3.7-plus"),
        transport=httpx.MockTransport(handler),
    )

    result = await AgentService(client).extract_async(
        [image(business_scope="new_vehicle")]
    )

    assert result.failed_count == 1
    assert result.failed_image_ids == ["0"]
    assert result.limitations == ["图片 0 Qwen 处理失败（invalid_response_structure）"]


@pytest.mark.asyncio
async def test_six_images_start_concurrently() -> None:
    class BlockingClient(FakeQwenClient):
        def __init__(self) -> None:
            super().__init__()
            self.active = 0
            self.max_active = 0
            self.all_started = asyncio.Event()
            self.release = asyncio.Event()

        async def extract_fields(
            self, image: dict[str, object], policy: object
        ) -> QwenExtraction:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if self.active == 6:
                self.all_started.set()
            await self.release.wait()
            self.active -= 1
            return QwenExtraction(
                document_type="invoice", fields={"invoice.code": "123"}
            )

    client = BlockingClient()
    service = AgentService(client, image_timeout=1, review_deadline=2)
    task = asyncio.create_task(
        service.extract_async([image(index, "invoice") for index in range(6)])
    )
    await asyncio.wait_for(client.all_started.wait(), timeout=0.5)

    assert client.max_active == 6
    client.release.set()
    result = await task
    assert result.completed_count == 6


@pytest.mark.asyncio
async def test_unknown_image_uses_one_combined_extraction_call() -> None:
    class CombinedClient(FakeQwenClient):
        def __init__(self) -> None:
            super().__init__()
            self.combined_calls: list[int] = []

        async def extract_unknown(self, image: dict[str, object]) -> QwenExtraction:
            self.combined_calls.append(int(image["index"]))
            return QwenExtraction(
                document_type="invoice",
                fields={"invoice.code": "123", "old_vehicle.vin": "OUT-OF-SCOPE"},
                confidence=0.9,
            )

    client = CombinedClient()
    result = await AgentService(client).extract_async(
        [image(category_hint="unknown", business_scope="new_vehicle")]
    )

    assert client.combined_calls == [0]
    assert client.classification_calls == []
    assert [(item.field, item.value) for item in result.observations] == [
        ("invoice.code", "123"),
        ("new_vehicle.vin", "OUT-OF-SCOPE"),
    ]


@pytest.mark.asyncio
async def test_business_scope_rejects_incompatible_model_document_type() -> None:
    class CombinedClient(FakeQwenClient):
        async def extract_unknown(self, image: dict[str, object]) -> QwenExtraction:
            return QwenExtraction(
                document_type="invoice",
                fields={
                    "invoice.code": "123",
                    "old_vehicle.vin": "MUST-NOT-BE-COMPARED-AS-OLD-VEHICLE",
                },
                confidence=0.9,
            )

    result = await AgentService(CombinedClient()).extract_async(
        [image(category_hint="scrap_certificate")]
    )

    assert result.observations == []
    assert any("发票位于报废车辆资料区域" in item for item in result.limitations)


@pytest.mark.asyncio
async def test_identical_vehicle_documents_are_routed_by_page_business_scope() -> None:
    class VehicleLicenseClient(FakeQwenClient):
        async def extract_unknown(self, image: dict[str, object]) -> QwenExtraction:
            return QwenExtraction(
                document_type="vehicle_license",
                fields={"vehicle.vin": f"VIN-{image['index']}"},
                confidence=0.9,
            )

    old_image = ImageInput(
        index=3,
        src="image",
        data_url="data:image/jpeg;base64,AA==",
        image_id="old_vehicle-01",
        business_scope="old_vehicle",
        group_title="报废车辆资料",
        group_order=1,
    )
    new_image = ImageInput(
        index=6,
        src="image",
        data_url="data:image/jpeg;base64,AA==",
        image_id="new_vehicle-01",
        business_scope="new_vehicle",
        group_title="新车资料",
        group_order=1,
    )

    result = await AgentService(VehicleLicenseClient()).extract_async(
        [old_image, new_image]
    )

    assert [
        (item.field, item.value, item.business_scope) for item in result.observations
    ] == [
        ("old_vehicle.vin", "VIN-3", "old_vehicle"),
        ("new_vehicle.vin", "VIN-6", "new_vehicle"),
    ]


@pytest.mark.asyncio
async def test_registration_certificate_fields_follow_page_business_scope() -> None:
    class RegistrationCertificateClient(FakeQwenClient):
        async def extract_unknown(self, image: dict[str, object]) -> QwenExtraction:
            return QwenExtraction(
                document_type="registration_certificate",
                fields={
                    "vehicle.owner": f"OWNER-{image['index']}",
                    "vehicle.vin": f"VIN-{image['index']}",
                    "vehicle.engine_model": f"ENGINE-{image['index']}",
                },
                confidence=0.9,
            )

    result = await AgentService(RegistrationCertificateClient()).extract_async(
        [
            image(index=3, business_scope="old_vehicle"),
            image(index=6, business_scope="new_vehicle"),
        ]
    )

    observations = {
        (item.field, item.value, item.business_scope, item.document_type)
        for item in result.observations
    }
    assert observations == {
        ("old_vehicle.owner", "OWNER-3", "old_vehicle", "registration_certificate"),
        ("old_vehicle.vin", "VIN-3", "old_vehicle", "registration_certificate"),
        (
            "old_vehicle.engine_model",
            "ENGINE-3",
            "old_vehicle",
            "registration_certificate",
        ),
        ("new_vehicle.owner", "OWNER-6", "new_vehicle", "registration_certificate"),
        ("new_vehicle.vin", "VIN-6", "new_vehicle", "registration_certificate"),
    }


@pytest.mark.asyncio
async def test_transfer_registration_uncertainty_becomes_a_structured_observation() -> (
    None
):
    fake = FakeQwenClient(
        extraction=QwenExtraction(
            document_type="registration_certificate",
            fields={"registration.covered_pages": [1, 2, 3, 4]},
            uncertain_fields=["registration.transfer_records"],
        )
    )
    result = await AgentService(fake).extract_async(
        [image(category_hint="registration_certificate", business_scope="transfer")]
    )

    uncertainty = next(
        item
        for item in result.observations
        if item.field == "transfer.uncertain_fields"
    )
    assert uncertainty.value == ["registration.transfer_records"]


@pytest.mark.asyncio
async def test_transfer_invoice_uncertainty_becomes_a_structured_observation() -> None:
    fake = FakeQwenClient(
        extraction=QwenExtraction(
            document_type="invoice",
            fields={"vehicle.vin": "VIN-1"},
            uncertain_fields=["vehicle.vin"],
        )
    )
    result = await AgentService(fake).extract_async(
        [image(category_hint="invoice", business_scope="transfer")]
    )

    uncertainty = next(
        item
        for item in result.observations
        if item.field == "transfer.uncertain_fields"
    )
    assert uncertainty.document_type == "invoice"
    assert uncertainty.value == ["vehicle.vin"]


@pytest.mark.asyncio
async def test_deadline_returns_completed_observations_and_marks_pending_timeout() -> (
    None
):
    class DelayClient(FakeQwenClient):
        async def extract_fields(
            self, image: dict[str, object], policy: object
        ) -> QwenExtraction:
            if int(image["index"]) == 1:
                await asyncio.sleep(1)
            return QwenExtraction(
                document_type="invoice",
                fields={"invoice.code": str(image["index"])},
            )

    progress: list[tuple[int, int]] = []
    result = await AgentService(
        DelayClient(),
        image_timeout=2,
        review_deadline=0.05,
    ).extract_async(
        [image(0, "invoice"), image(1, "invoice")],
        on_progress=lambda snapshot: progress.append(
            (snapshot.completed_count, snapshot.timed_out_count)
        ),
    )

    assert [(item.field, item.value) for item in result.observations] == [
        ("invoice.code", "0")
    ]
    assert result.completed_count == 1
    assert result.timed_out_count == 1
    assert progress
