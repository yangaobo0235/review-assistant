from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class ToolResult:
    fields: dict[str, Any] = field(default_factory=dict)
    confidence: float | None = None
    raw_text: str = ""
    error: str | None = None


class OcrTool(Protocol):
    def recognize(self, image: Any) -> ToolResult: ...


class VisionTool(Protocol):
    def inspect(self, image: Any, document_type: str) -> ToolResult: ...


class QrCodeTool(Protocol):
    def decode(self, image: Any, image_index: int | None = None) -> list[Any]: ...


class MockOcrTool:
    def recognize(self, image: Any) -> ToolResult:
        return ToolResult()


class MockVisionTool:
    def inspect(self, image: Any, document_type: str) -> ToolResult:
        return ToolResult()
