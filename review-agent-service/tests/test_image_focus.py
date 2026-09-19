"""局部重读的裁剪与坐标推断。

坐标约定是推断的（模型可能给归一化比例、千分位或像素），所以这里既验证
正常裁剪，也验证**推断失败时放弃裁剪**——错误的裁剪会丢掉真正要看的区域，
比不裁剪更糟。
"""

import base64

import numpy as np
import pytest

from app.workflow.image_focus import focus_data_url, uncertain_boxes, union_box
from app.workflow.models import EvidenceRegion, QwenExtraction

WIDTH, HEIGHT = 1600, 1200


def _image_data_url() -> str:
    import cv2

    frame = np.full((HEIGHT, WIDTH, 3), 255, dtype=np.uint8)
    frame[300:600, 400:900] = 0  # 一块待裁剪的深色区域
    ok, encoded = cv2.imencode(".jpg", frame)
    assert ok
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def _decode(data_url: str) -> tuple[int, int]:
    import cv2

    raw = base64.b64decode(data_url.partition(",")[2])
    frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert frame is not None
    return frame.shape[1], frame.shape[0]


def test_pixel_coordinates_crop_to_the_requested_region() -> None:
    box = union_box([[400, 300, 900, 600]], WIDTH, HEIGHT)

    assert box is not None
    left, top, right, bottom = box
    assert left < 400 and top < 300 and right > 900 and bottom > 600
    assert right - left < WIDTH


def test_normalized_coordinates_are_scaled_to_the_image() -> None:
    from_pixels = union_box([[400, 300, 900, 600]], WIDTH, HEIGHT)
    from_fraction = union_box(
        [[400 / WIDTH, 300 / HEIGHT, 900 / WIDTH, 600 / HEIGHT]], WIDTH, HEIGHT
    )

    assert from_fraction is not None
    assert from_pixels is not None
    assert from_fraction == pytest.approx(from_pixels, abs=2)


def test_a_region_covering_most_of_the_image_gives_up() -> None:
    """区域过大说明坐标约定多半推断错了，放弃裁剪比裁错好。"""
    assert union_box([[0, 0, WIDTH, HEIGHT]], WIDTH, HEIGHT) is None
    assert union_box([[0, 0, 0.95, 0.95]], WIDTH, HEIGHT) is None


def test_degenerate_boxes_are_rejected() -> None:
    assert union_box([], WIDTH, HEIGHT) is None
    assert union_box([[100, 100, 100, 100]], WIDTH, HEIGHT) is None
    assert union_box([[500, 500, 100, 100]], WIDTH, HEIGHT) is None
    assert union_box([[1, 2, 3]], WIDTH, HEIGHT) is None


def test_focus_returns_a_smaller_upright_image() -> None:
    focused = focus_data_url(_image_data_url(), [[400, 300, 900, 600]])

    assert focused is not None
    assert focused.startswith("data:image/jpeg;base64,")
    width, height = _decode(focused)
    # 裁剪后短边至少放大到 MIN_OUTPUT_SIDE，长边按比例缩放。
    assert min(width, height) >= 1024 or abs(width / height - 500 / 300) < 0.1


def test_focus_refuses_when_it_cannot_help() -> None:
    data_url = _image_data_url()

    assert focus_data_url(None, [[400, 300, 900, 600]]) is None
    assert focus_data_url(data_url, []) is None
    assert focus_data_url(data_url, [[0, 0, WIDTH, HEIGHT]]) is None
    assert focus_data_url("data:image/jpeg;base64,", [[400, 300, 900, 600]]) is None
    assert focus_data_url("not-a-data-url", [[400, 300, 900, 600]]) is None


def test_uncertain_boxes_pick_only_the_named_fields() -> None:
    extraction = QwenExtraction(
        document_type="invoice",
        fields={"invoice.invoice_no": "123"},
        evidence_regions=[
            EvidenceRegion(field="invoice.amount", box=[10, 20, 30, 40]),
            EvidenceRegion(field="invoice.invoice_no", box=[50, 60, 70, 80]),
        ],
    )

    assert uncertain_boxes(extraction, ["invoice.amount"]) == [[10, 20, 30, 40]]
    assert uncertain_boxes(extraction, ["invoice.invoice_no", "invoice.amount"]) == [
        [10, 20, 30, 40],
        [50, 60, 70, 80],
    ]
    assert uncertain_boxes(extraction, ["invoice.code"]) == []


def test_uncertain_boxes_tolerate_missing_regions() -> None:
    extraction = QwenExtraction(document_type="invoice", fields={})

    assert uncertain_boxes(extraction, ["invoice.amount"]) == []
    assert uncertain_boxes(object(), ["invoice.amount"]) == []
