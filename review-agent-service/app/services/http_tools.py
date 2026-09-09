from typing import Any

import httpx

from app.services.tools import ToolResult


class HttpOcrTool:
    """将图片元数据转发到外部 OCR 服务，统一转换成 ToolResult。"""

    def __init__(
        self,
        endpoint: str,
        *,
        timeout: float = 30.0,
        api_key: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.endpoint = endpoint
        self.timeout = timeout
        self.api_key = api_key
        self.transport = transport

    async def recognize(self, image: Any) -> ToolResult:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        payload = {"image": image}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport) as client:
                response = await client.post(self.endpoint, json=payload, headers=headers)
            if response.status_code < 200 or response.status_code >= 300:
                return ToolResult(error=f"OCR 服务返回 HTTP {response.status_code}")
            data = response.json()
            if not isinstance(data.get("fields", {}), dict):
                return ToolResult(error="OCR 服务响应缺少 fields 对象")
            return ToolResult(
                fields=data.get("fields", {}),
                confidence=data.get("confidence"),
                raw_text=data.get("raw_text", ""),
            )
        except (httpx.HTTPError, ValueError) as exc:
            return ToolResult(error=f"OCR 服务调用失败: {exc}")
