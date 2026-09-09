import httpx
import pytest

from app.services.http_tools import HttpOcrTool


@pytest.mark.asyncio
async def test_http_ocr_tool_parses_structured_fields() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/ocr"
        return httpx.Response(200, json={"fields": {"vin": "ABC123"}, "confidence": 0.95})

    tool = HttpOcrTool("https://ocr.example/ocr", transport=httpx.MockTransport(handler))
    result = await tool.recognize({"src": "https://example/image.jpg"})

    assert result.fields == {"vin": "ABC123"}
    assert result.confidence == 0.95


@pytest.mark.asyncio
async def test_http_ocr_tool_returns_error_for_non_success() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    tool = HttpOcrTool("https://ocr.example/ocr", transport=transport)
    result = await tool.recognize({"src": "https://example/image.jpg"})

    assert result.error == "OCR 服务返回 HTTP 503"
