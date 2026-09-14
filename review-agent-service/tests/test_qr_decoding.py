import cv2
import numpy as np
from app.services.qr import QrCodeService

EXPECTED_URL = "https://qclt.mofcom.gov.cn/deal/scrap/validdata/test-token"


def make_qr(value: str, size: int = 116) -> np.ndarray:
    encoder = cv2.QRCodeEncoder_create()
    qr = encoder.encode(value)
    return cv2.resize(qr, (size, size), interpolation=cv2.INTER_NEAREST)


def photographed_certificate() -> np.ndarray:
    canvas = np.full((1400, 2200, 3), 220, dtype=np.uint8)
    qr = make_qr(EXPECTED_URL)
    low_contrast = np.where(qr > 0, 205, 62).astype(np.uint8)
    low_contrast = cv2.cvtColor(low_contrast, cv2.COLOR_GRAY2BGR)
    canvas[1120:1236, 180:296] = low_contrast
    return canvas


def test_decodes_small_low_contrast_qr_in_lower_left_certificate_region():
    results = QrCodeService().decode(photographed_certificate(), image_index=3)
    assert [item.raw_value for item in results] == [EXPECTED_URL]


def test_decodes_rotated_certificate_photo():
    rotated = cv2.rotate(photographed_certificate(), cv2.ROTATE_90_CLOCKWISE)
    results = QrCodeService().decode(rotated, image_index=3)
    assert [item.raw_value for item in results] == [EXPECTED_URL]


def test_uses_zxing_when_opencv_decoder_cannot_read(monkeypatch):
    class EmptyDetector:
        def detectAndDecode(self, image):
            return "", None, None

    monkeypatch.setattr(cv2, "QRCodeDetector", EmptyDetector)
    results = QrCodeService().decode(photographed_certificate(), image_index=3)
    assert [item.raw_value for item in results] == [EXPECTED_URL]


def test_candidate_generation_is_bounded() -> None:
    candidates = list(QrCodeService._candidates(photographed_certificate()))

    assert len(candidates) <= 12


def test_lower_left_qr_is_found_when_certificate_text_extends_above_crop() -> None:
    """The QR on a photographed recycling certificate is below dense table text.

    The old fixed 45% crop removed the QR finder pattern on some portrait photos;
    the overlapping lower-left candidate must still decode it.
    """
    canvas = np.full((517, 735, 3), 235, dtype=np.uint8)
    # Add table-like horizontal lines/noise above the QR to reproduce the
    # certificate layout without checking in a real applicant document.
    for y in range(30, 280, 18):
        cv2.line(canvas, (0, y), (730, y), (180, 180, 180), 1)
    qr = make_qr(EXPECTED_URL, size=145)
    canvas[300:445, 40:185] = cv2.cvtColor(qr, cv2.COLOR_GRAY2BGR)

    results = QrCodeService().decode(canvas, image_index=3)

    assert [item.raw_value for item in results] == [EXPECTED_URL]


def test_decode_rounds_stop_before_work_when_deadline_expired(monkeypatch) -> None:
    service = QrCodeService()
    calls = 0

    def fail_if_called(image, image_index=None, **kwargs):
        nonlocal calls
        calls += 1
        return []

    monkeypatch.setattr(service, "decode", fail_if_called)
    results, attempts = service.decode_with_rounds(
        photographed_certificate(),
        image_index=3,
        max_rounds=3,
        absolute_deadline=0.0,
    )

    assert results == []
    assert attempts == []
    assert calls == 0


def test_third_decode_round_uses_bounded_tiles(monkeypatch) -> None:
    service = QrCodeService()
    calls = 0

    def empty_decode(image, image_index=None, **kwargs):
        nonlocal calls
        calls += 1
        return []

    monkeypatch.setattr(service, "decode", empty_decode)
    service.decode_with_rounds(
        photographed_certificate(), image_index=3, max_rounds=3
    )

    assert calls <= 12
