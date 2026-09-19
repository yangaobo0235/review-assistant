"""按证据区域裁剪并放大图片，用于局部重读。

模型自报"看不清"某个字段时会给出该字段在图片中的位置（`evidence_regions`）。
重读时把这些区域裁出来放大，比让它整张图重新看一遍更有效。

**坐标约定是推断的，不是约定的。** 模型可能返回归一化比例（0–1）、千分位
（0–1000）或像素坐标，而 `evidence_regions` 目前在别处没有消费者，无法从
既有代码反推。因此这里的策略是「推断 + 保守放弃」：推断出的区域过大或退化
时直接返回 None，调用方退回整图重读——**错误的裁剪会丢掉真正要看的区域，
比不裁剪更糟**。
"""

from __future__ import annotations

import base64
import binascii
import logging
from collections.abc import Sequence

logger = logging.getLogger("uvicorn.error")

# 裁剪时在区域四周留出的边距比例，避免把紧贴的印章或表格线切掉。
DEFAULT_PADDING = 0.05
# 推断出的区域超过整图这个比例时放弃裁剪：多半是坐标约定推断错了。
MAX_COVERAGE = 0.7
# 裁剪后短边至少要放大到这个像素数，太小的截图模型照样看不清。
MIN_OUTPUT_SIDE = 1024
# 裁剪结果小于这个像素数视为退化，放弃。
MIN_CROP_SIDE = 24

Box = Sequence[float]


def _decode(data_url: str) -> bytes | None:
    _, _, encoded = data_url.partition(",")
    if not encoded:
        return None
    try:
        return base64.b64decode(encoded)
    except (binascii.Error, ValueError):
        return None


def _to_pixels(box: Box, width: int, height: int) -> tuple[float, float, float, float] | None:
    """把模型给出的区域换算成像素坐标；无法可靠换算时返回 None。"""
    if len(box) < 4:
        return None
    x1, y1, x2, y2 = (float(value) for value in box[:4])
    if x2 <= x1 or y2 <= y1:
        return None

    largest = max(x1, y1, x2, y2)
    if largest <= 1.0:
        # 归一化比例。
        return x1 * width, y1 * height, x2 * width, y2 * height
    # 其余按像素处理。这里**不**猜"千分位"：像素值也可能小于 1000，
    # 两种约定无法从数值本身区分，猜错会把裁剪框放到图片角落里。
    # 真实运行后看日志里记录的原始坐标再决定要不要加这种约定。
    return x1, y1, x2, y2


def union_box(
    boxes: Sequence[Box],
    width: int,
    height: int,
) -> tuple[int, int, int, int] | None:
    """把多个区域合成一个外接矩形并加上边距；区域过大或退化时返回 None。"""
    pixels = [value for box in boxes if (value := _to_pixels(box, width, height))]
    if not pixels:
        return None

    x1 = min(item[0] for item in pixels)
    y1 = min(item[1] for item in pixels)
    x2 = max(item[2] for item in pixels)
    y2 = max(item[3] for item in pixels)

    pad_x = (x2 - x1) * DEFAULT_PADDING
    pad_y = (y2 - y1) * DEFAULT_PADDING
    left = max(0, int(x1 - pad_x))
    top = max(0, int(y1 - pad_y))
    right = min(width, int(x2 + pad_x))
    bottom = min(height, int(y2 + pad_y))

    if right - left < MIN_CROP_SIDE or bottom - top < MIN_CROP_SIDE:
        return None
    if (right - left) * (bottom - top) > width * height * MAX_COVERAGE:
        return None
    return left, top, right, bottom


def focus_data_url(
    data_url: str | None,
    boxes: Sequence[Box],
) -> str | None:
    """裁剪到给定区域并放大，返回新的 data URL；不改动或无法处理时返回 None。

    返回 None 表示"按整图重读"，是安全的降级：调用方不需要区分"区域不好"
    和"图片读不了"。
    """
    if not data_url or not boxes:
        return None
    raw = _decode(data_url)
    if raw is None:
        return None

    try:
        import cv2
        import numpy as np
    except ImportError:  # pragma: no cover - 依赖缺失时退回整图重读
        logger.warning("图片处理依赖不可用，局部重读退回整图")
        return None

    buffer = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if frame is None:
        return None
    height, width = frame.shape[:2]

    crop = union_box(boxes, width, height)
    if crop is None:
        # 记录原始坐标：坐标约定是推断的，第一次真实运行后据此校正。
        logger.info(
            "局部重读放弃裁剪 image=%sx%s boxes=%s",
            width,
            height,
            [list(box) for box in boxes],
        )
        return None
    left, top, right, bottom = crop

    patch = frame[top:bottom, left:right]
    scale = max(1.0, MIN_OUTPUT_SIDE / max(1, min(patch.shape[:2])))
    if scale > 1.0:
        patch = cv2.resize(
            patch,
            None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_CUBIC,
        )

    ok, encoded = cv2.imencode(".jpg", patch, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def uncertain_boxes(extraction: object, fields: Sequence[str]) -> list[list[float]]:
    """取出这些字段在图片中的证据区域；没有记录时返回空列表。"""
    wanted = set(fields)
    boxes: list[list[float]] = []
    for region in getattr(extraction, "evidence_regions", ()) or ():
        if getattr(region, "field", None) in wanted and getattr(region, "box", None):
            boxes.append(list(region.box))
    return boxes
