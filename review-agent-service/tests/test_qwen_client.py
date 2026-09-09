import json

import httpx
import pytest

from app.agent.config import QwenConfig
from app.agent.document_policies import DOCUMENT_POLICIES
from app.agent.models import QwenExtraction
from app.agent.qwen_client import (
    QwenClient,
    QwenResponseSchemaError,
    QwenResponseSyntaxError,
    parse_qwen_extraction,
)

CONFIG = QwenConfig("key", "https://dashscope.test/v1", "qwen3.7-plus")
IMAGE = {"index": 2, "data_url": "data:image/jpeg;base64,AA=="}


@pytest.mark.asyncio
async def test_qwen_client_classifies_without_requesting_fields() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        prompt = payload["messages"][0]["content"][0]["text"]
        assert payload["model"] == "qwen3.7-plus"
        assert payload["enable_thinking"] is False
        assert "不要提取业务字段" in prompt
        assert "invoice.code" not in prompt
        assert payload["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/")
        assert payload["response_format"] == {"type": "json_object"}
        result = {"document_type": "invoice", "confidence": 0.98, "reason": "含发票标题"}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(result)}}]})

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))
    result = await client.classify_document(IMAGE)

    assert result.document_type == "invoice"
    assert result.confidence == 0.98


@pytest.mark.asyncio
async def test_qwen_client_uses_policy_prompt_and_preserves_evidence_box() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        prompt = payload["messages"][0]["content"][0]["text"]
        assert "机动车销售发票" in prompt
        assert "invoice.code" in prompt
        assert "old_vehicle.vin" not in prompt
        result = {
            "document_type": "invoice",
            "fields": {"invoice.code": "123"},
            "confidence": 0.9,
            "evidence_regions": [
                {"field": "invoice.code", "image_index": 2, "box": [1, 2, 3, 4]}
            ],
            "uncertain_fields": [],
        }
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(result)}}]})

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))
    result = await client.extract_fields(IMAGE, DOCUMENT_POLICIES["invoice"])

    assert result.fields == {"invoice.code": "123"}
    assert result.evidence_regions[0].box == [1.0, 2.0, 3.0, 4.0]


@pytest.mark.asyncio
async def test_qwen_client_requires_api_key() -> None:
    client = QwenClient(QwenConfig(None, "https://dashscope.test/v1", "qwen3.7-plus"))
    with pytest.raises(RuntimeError, match="DASHSCOPE_API_KEY"):
        await client.extract_fields(IMAGE, DOCUMENT_POLICIES["invoice"])


@pytest.mark.asyncio
async def test_qwen_client_unknown_prompt_classifies_and_extracts_in_one_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        prompt = payload["messages"][0]["content"][0]["text"]
        assert "判断资料类型并提取" in prompt
        assert "scrap_certificate" in prompt
        assert "invoice.code" in prompt
        result = {
            "document_type": "invoice",
            "fields": {"invoice.code": "123"},
            "confidence": 0.9,
        }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))
    result = await client.extract_unknown(IMAGE)

    assert result.document_type == "invoice"
    assert result.fields == {"invoice.code": "123"}


@pytest.mark.asyncio
async def test_qwen_client_restricts_new_registration_certificate_prompt() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        prompt = payload["messages"][0]["content"][0]["text"]
        assert "vehicle.owner" in prompt
        assert "vehicle.vin" in prompt
        assert "vehicle.engine_model" not in prompt
        result = {
            "document_type": "registration_certificate",
            "fields": {"vehicle.vin": "TESTVIN"},
        }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))
    registration_image = {
        **IMAGE,
        "business_scope": "new_vehicle",
        "document_type_hint": "registration_certificate",
    }

    result = await client.extract_unknown(registration_image)

    assert result.fields == {"vehicle.vin": "TESTVIN"}


@pytest.mark.asyncio
async def test_qwen_client_accepts_fenced_extraction_json() -> None:
    result = {
        "document_type": "vehicle_license",
        "fields": {"vehicle_license.vin": "TESTVIN"},
        "confidence": 0.9,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        content = f"```json\n{json.dumps(result)}\n```"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": content}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    extraction = await client.extract_unknown(IMAGE)

    assert extraction.fields == {"vehicle_license.vin": "TESTVIN"}


@pytest.mark.asyncio
async def test_qwen_client_accepts_extraction_json_surrounded_by_text() -> None:
    result = {
        "document_type": "vehicle_license",
        "fields": {"vehicle_license.vin": "TESTVIN"},
        "confidence": 0.9,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        content = f"识别结果如下：\n{json.dumps(result)}\n请人工复核。"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": content}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    extraction = await client.extract_unknown(IMAGE)

    assert extraction.document_type == "vehicle_license"


@pytest.mark.asyncio
async def test_qwen_client_prefers_fenced_json_over_a_preceding_example() -> None:
    example = {"document_type": "invoice", "fields": {"invoice.code": "EXAMPLE"}}
    actual = {
        "document_type": "vehicle_license",
        "fields": {"vehicle_license.vin": "TESTVIN"},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        content = f"示例：{json.dumps(example)}\n```json\n{json.dumps(actual)}\n```"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": content}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    extraction = await client.extract_unknown(IMAGE)

    assert extraction.document_type == "vehicle_license"
    assert extraction.fields == {"vehicle_license.vin": "TESTVIN"}


@pytest.mark.asyncio
async def test_qwen_client_rejects_multiple_unfenced_json_objects() -> None:
    first = {"document_type": "invoice", "fields": {"invoice.code": "FIRST"}}
    second = {"document_type": "invoice", "fields": {"invoice.code": "SECOND"}}

    def handler(request: httpx.Request) -> httpx.Response:
        content = f"{json.dumps(first)}\n{json.dumps(second)}"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": content}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    with pytest.raises(RuntimeError, match="响应格式无效"):
        await client.extract_unknown(IMAGE)


@pytest.mark.asyncio
async def test_qwen_client_normalizes_nullable_extraction_collections() -> None:
    result = {
        "document_type": "vehicle_license",
        "fields": None,
        "evidence_regions": None,
        "uncertain_fields": None,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    extraction = await client.extract_unknown(IMAGE)

    assert extraction.fields == {}
    assert extraction.evidence_regions == []
    assert extraction.uncertain_fields == []


@pytest.mark.asyncio
async def test_qwen_client_drops_null_extraction_field_values() -> None:
    result = {
        "document_type": "vehicle_license",
        "fields": {
            "vehicle_license.vin": "TESTVIN",
            "vehicle_license.plate_number": None,
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    extraction = await client.extract_unknown(IMAGE)

    assert extraction.fields == {"vehicle_license.vin": "TESTVIN"}


@pytest.mark.asyncio
async def test_qwen_client_rejects_extraction_without_json_object() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "未能识别图片内容"}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))

    with pytest.raises(RuntimeError, match="响应格式无效"):
        await client.extract_unknown(IMAGE)


@pytest.mark.asyncio
async def test_qwen_client_retries_rate_limit_once() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, json={"message": "rate limited"})
        result = {"document_type": "invoice", "fields": {"invoice.code": "123"}}
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(result)}}]},
        )

    client = QwenClient(CONFIG, transport=httpx.MockTransport(handler))
    result = await client.extract_fields(IMAGE, DOCUMENT_POLICIES["invoice"])

    assert attempts == 2
    assert result.fields == {"invoice.code": "123"}


def test_qwen_extraction_accepts_field_to_boxes_evidence_mapping() -> None:
    result = QwenExtraction.model_validate(
        {
            "fields": {"invoice.code": "123"},
            "evidence_regions": {"invoice.code": [[1, 2, 3, 4]]},
        }
    )

    assert result.evidence_regions[0].field == "invoice.code"
    assert result.evidence_regions[0].box == [1, 2, 3, 4]


def test_qwen_parser_reports_syntax_without_response_content() -> None:
    with pytest.raises(QwenResponseSyntaxError) as captured:
        parse_qwen_extraction('{"fields": "SECRET"')

    assert "SECRET" not in str(captured.value)


def test_qwen_parser_reports_safe_schema_paths_without_field_values() -> None:
    content = json.dumps({"confidence": 9, "fields": ["SECRET"]})

    with pytest.raises(QwenResponseSchemaError) as captured:
        parse_qwen_extraction(content)

    assert "confidence:less_than_equal" in captured.value.detail
    assert "fields:dict_type" in captured.value.detail
    assert "SECRET" not in captured.value.detail


def test_qwen_extraction_accepts_structured_registration_values() -> None:
    extraction = QwenExtraction.model_validate({
        "document_type": "registration_certificate",
        "fields": {
            "registration.covered_pages": [1, 2],
            "registration.transfer_records": [
                {"owner": "甲公司", "date": "2025-01-02", "page": 2, "order": 1},
            ],
        },
    })

    assert extraction.fields["registration.covered_pages"] == [1, 2]


def test_qwen_parser_drops_unassociated_evidence_without_losing_fields() -> None:
    content = json.dumps(
        {
            "document_type": "registration_certificate",
            "fields": {
                "vehicle.owner": "TEST OWNER",
                "vehicle.vin": "TESTVIN",
            },
            "evidence_regions": [
                {"image_index": 4, "box": [1, 2, 3, 4]},
                {"field": "vehicle.vin", "image_index": 4, "box": [5, 6, 7, 8]},
                {"field": "vehicle.owner", "image_index": 4, "box": [1, 2]},
            ],
        }
    )

    extraction = parse_qwen_extraction(content)

    assert extraction.fields == {
        "vehicle.owner": "TEST OWNER",
        "vehicle.vin": "TESTVIN",
    }
    assert [region.field for region in extraction.evidence_regions] == ["vehicle.vin"]


@pytest.mark.parametrize(
    ("raw_value", "expected"),
    [
        ("registration.transfer_records", ["registration.transfer_records"]),
        ("   ", []),
    ],
)
def test_qwen_parser_normalizes_single_uncertain_field_string(
    raw_value: str,
    expected: list[str],
) -> None:
    extraction = parse_qwen_extraction(json.dumps({
        "document_type": "registration_certificate",
        "fields": {},
        "uncertain_fields": raw_value,
    }))

    assert extraction.uncertain_fields == expected


def test_qwen_parser_still_rejects_non_string_uncertain_field_values() -> None:
    with pytest.raises(QwenResponseSchemaError) as captured:
        parse_qwen_extraction(json.dumps({
            "document_type": "registration_certificate",
            "fields": {},
            "uncertain_fields": {"field": "registration.transfer_records"},
        }))

    assert captured.value.detail == "uncertain_fields:list_type"


def test_qwen_parser_rejects_contaminated_registration_owner_without_guessing() -> None:
    extraction = parse_qwen_extraction(json.dumps({
        "document_type": "registration_certificate",
        "fields": {
            "registration.covered_pages": [1, 2],
            "registration.initial_owner": (
                "孟永旗/居民身份证/130182198503243736/一汽财务有限公司"
            ),
        },
        "uncertain_fields": [],
    }))

    assert "registration.initial_owner" not in extraction.fields
    assert extraction.uncertain_fields == ["registration.initial_owner"]


@pytest.mark.parametrize("owner", ["孟永旗", "一汽财务有限公司"])
def test_qwen_parser_keeps_plausible_registration_owner(owner: str) -> None:
    extraction = parse_qwen_extraction(json.dumps({
        "document_type": "registration_certificate",
        "fields": {"registration.initial_owner": owner},
        "uncertain_fields": [],
    }))

    assert extraction.fields["registration.initial_owner"] == owner
    assert extraction.uncertain_fields == []
