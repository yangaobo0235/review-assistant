import numpy as np

from app.services.qr import QrCodeService, validate_qr_url
from app.services.tools import MockOcrTool, MockVisionTool


def test_mock_tools_return_structured_empty_results() -> None:
    image = {"index": 1, "src": "https://example.test/a.jpg", "group": "回收证明"}
    ocr = MockOcrTool()
    vision = MockVisionTool()

    assert ocr.recognize(image).fields == {}
    assert vision.inspect(image, "scrap_certificate").fields == {}


def test_qr_url_accepts_only_https_whitelist() -> None:
    assert validate_qr_url("https://test.forjtruck.com/cert/1", ["test.forjtruck.com"])
    assert not validate_qr_url("http://test.forjtruck.com/cert/1", ["test.forjtruck.com"])
    assert not validate_qr_url("https://evil.example/cert/1", ["test.forjtruck.com"])


def test_qr_service_returns_no_codes_for_blank_image() -> None:
    result = QrCodeService().decode(np.zeros((100, 100), dtype=np.uint8), image_index=2)
    assert result == []
