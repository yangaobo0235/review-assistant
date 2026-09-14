import json

import httpx
import pytest

from app.agent.config import QwenConfig
from app.agent.models import QwenExtraction
from app.agent.qwen_client import QwenClient
from app.agent.service import AgentService
from app.businesses.material_policies import DEFAULT_RETRY_POLICY
from app.models.review import ImageInput


def invoice_image() -> ImageInput:
    return ImageInput(index=0, src="image", data_url="data:image/jpeg;base64,AA==", category_hint="invoice", business_scope="new_vehicle")


class SequencedClient:
    def __init__(self) -> None:
        self.calls = 0

    async def extract_fields(
        self,
        image: dict[str, object],
        policy: object,
        *,
        retry_reason: str | None = None,
    ) -> QwenExtraction:
        self.calls += 1
        return QwenExtraction(
            document_type="invoice",
            fields={"invoice.invoice_no": "B" if self.calls == 2 else "A"},
            confidence=0.92 if self.calls == 2 else 0.69,
        )


@pytest.mark.asyncio
async def test_low_confidence_retries_once_and_uses_second_result() -> None:
    client = SequencedClient()
    result = await AgentService(client).extract_async([invoice_image()], retry_policy=DEFAULT_RETRY_POLICY)
    assert client.calls == 2
    assert [(item.field, item.value) for item in result.observations] == [
        ("invoice.invoice_no", "B"),
        ("invoice.code", "B"),
    ]
    assert result.retry_summary.qwen_retries == 1
    assert result.completed_count == 1


@pytest.mark.asyncio
async def test_invalid_schema_retry_adds_targeted_correction_to_prompt() -> None:
    prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        prompts.append(payload["messages"][0]["content"][0]["text"])
        if len(prompts) == 1:
            result = {
                "document_type": "invoice",
                "fields": {"invoice.code": "123"},
                "confidence": 0.9,
                "evidence_regions": [],
                "uncertain_fields": {"field": "invoice.code"},
            }
        else:
            result = {
                "document_type": "invoice",
                "fields": {"invoice.code": "123"},
                "confidence": 0.9,
                "evidence_regions": [],
                "uncertain_fields": [],
            }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(
        QwenConfig("key", "https://dashscope.test/v1", "qwen3.7-plus"),
        transport=httpx.MockTransport(handler),
    )
    result = await AgentService(client).extract_async(
        [invoice_image()],
        retry_policy=DEFAULT_RETRY_POLICY,
    )

    assert len(prompts) == 2
    assert "上一次响应字段类型错误" not in prompts[0]
    assert "上一次响应字段类型错误" in prompts[1]
    assert "uncertain_fields 必须是字符串数组" in prompts[1]
    assert result.completed_count == 1
    assert result.failed_count == 0
    assert result.retry_summary.attempts[0].reason_code == "invalid_schema"


@pytest.mark.asyncio
async def test_contaminated_registration_owner_retries_with_targeted_prompt() -> None:
    prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        prompts.append(payload["messages"][0]["content"][0]["text"])
        owner = (
            "孟永旗/居民身份证/130182198503243736/一汽财务有限公司"
            if len(prompts) == 1
            else "孟永旗"
        )
        result = {
            "document_type": "registration_certificate",
            "fields": {
                "registration.covered_pages": [1, 2],
                "registration.initial_owner": owner,
            },
            "confidence": 0.9,
            "evidence_regions": [],
            "uncertain_fields": [],
        }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(
        QwenConfig("key", "https://dashscope.test/v1", "qwen3.7-plus"),
        transport=httpx.MockTransport(handler),
    )
    registration_image = ImageInput(
        index=0,
        src="image",
        data_url="data:image/jpeg;base64,AA==",
        category_hint="registration_certificate",
        business_scope="transfer",
    )
    result = await AgentService(client).extract_async(
        [registration_image],
        retry_policy=DEFAULT_RETRY_POLICY,
    )

    assert len(prompts) == 2
    assert "初始所有人识别内容混入" not in prompts[0]
    assert "初始所有人识别内容混入" in prompts[1]
    assert result.retry_summary.attempts[0].reason_code == "invalid_registration_owner"
    owner = next(
        item.value
        for item in result.observations
        if item.field == "transfer.registration.initial_owner"
    )
    assert owner == "孟永旗"
