"""报废证明二维码核验。

主要职责：解码二维码、校验官方域名并提取官网字段。
修改日期：2026-08-26
修改人：wuyi
"""

import base64
import re
import ssl
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from html import unescape
from typing import Any
from urllib.parse import urlparse

import cv2
import httpx
import numpy as np
import zxingcpp

from app.agent.models import RetryAttempt


@dataclass
class QrCodeResult:
    image_index: int | None
    raw_value: str
    url: str | None = None
    domain_valid: bool | None = None
    page_fields: dict[str, Any] = field(default_factory=dict)
    status: str = "REVIEW_REQUIRED"
    accessible: bool | None = None


def validate_qr_url(url: str, allowed_hosts: list[str]) -> bool:
    """只允许 HTTPS 且命中白名单主机，避免二维码触发任意外部跳转。"""
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in set(allowed_hosts)


def canonicalize_official_qr_url(url: str, allowed_hosts: list[str]) -> str | None:
    """Accept an official legacy HTTP QR only by upgrading it to HTTPS before access."""
    parsed = urlparse(url)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in set(allowed_hosts)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in {None, 80, 443}
    ):
        return None
    hostname = parsed.hostname or ""
    netloc = hostname if parsed.port in {None, 80} else f"{hostname}:443"
    return parsed._replace(scheme="https", netloc=netloc).geturl()


def create_official_ssl_context() -> ssl.SSLContext:
    """Keep certificate verification while allowing the official site's legacy ciphers."""
    context = ssl.create_default_context()
    context.set_ciphers("DEFAULT@SECLEVEL=1")
    return context


def extract_page_fields(html: str) -> dict[str, str]:
    """Extract the two official recycling-certificate fields from simple HTML pages."""
    text = unescape(re.sub(r"<[^>]+>", " ", html))
    text = re.sub(r"\s+", " ", text).strip()
    patterns = {
        "certificate_no": r"(?:回收证明编号|证明编号|回收证明号)\s*[:：]?\s*([A-Za-z0-9一-龥][A-Za-z0-9一-龥\-/]*)",
        "vin": r"(?:车架号|车辆识别代号|VIN)\s*[:：]?\s*([A-Za-z0-9]{6,32})",
    }
    result: dict[str, str] = {}
    for field_name, pattern in patterns.items():
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            result[field_name] = match.group(1).strip()
    return result


class QrCodeService:
    """使用 ZXing-C++ 主解码，并以 OpenCV 和有限预处理候选回退。"""

    def decode(
        self,
        image: Any,
        image_index: int | None = None,
        *,
        absolute_deadline: float | None = None,
    ) -> list[QrCodeResult]:
        if not isinstance(image, np.ndarray) or image.size == 0:
            return []
        for candidate in self._candidates(image):
            if self._deadline_reached(absolute_deadline):
                return []
            values = self._decode_zxing(candidate)
            if values:
                return [QrCodeResult(image_index=image_index, raw_value=value) for value in values]
        detector = cv2.QRCodeDetector()
        for candidate in self._opencv_candidates(image):
            if self._deadline_reached(absolute_deadline):
                return []
            values = self._decode_opencv(detector, candidate)
            if values:
                return [QrCodeResult(image_index=image_index, raw_value=value) for value in values]
        return []

    @staticmethod
    def _decode_zxing(image: np.ndarray) -> list[str]:
        values: list[str] = []
        try:
            for result in zxingcpp.read_barcodes(
                image,
                formats=zxingcpp.BarcodeFormat.QRCode,
                try_rotate=True,
                try_downscale=False,
                try_invert=True,
            ):
                if result.text and result.text not in values:
                    values.append(result.text)
        except (RuntimeError, TypeError, ValueError):
            pass
        return values

    @staticmethod
    def _decode_opencv(detector: Any, image: np.ndarray) -> list[str]:
        try:
            value, _, _ = detector.detectAndDecode(image)
        except cv2.error:
            value = ""
        return [value] if value else []

    @staticmethod
    def _candidates(image: np.ndarray) -> Iterator[np.ndarray]:
        yield image
        gray_image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        yield gray_image
        rotation_codes = (
            None,
            cv2.ROTATE_90_CLOCKWISE,
            cv2.ROTATE_180,
            cv2.ROTATE_90_COUNTERCLOCKWISE,
        )
        for rotation_code in rotation_codes:
            rotated = image if rotation_code is None else cv2.rotate(image, rotation_code)
            height, width = rotated.shape[:2]
            roi = rotated[int(height * 0.45) : height, : int(width * 0.48)]
            if roi.size == 0:
                continue
            gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi
            yield gray
            yield cv2.resize(
                gray,
                None,
                fx=2,
                fy=2,
                interpolation=cv2.INTER_CUBIC,
            )

    @staticmethod
    def _opencv_candidates(image: np.ndarray) -> Iterator[np.ndarray]:
        yield image
        height, width = image.shape[:2]
        roi = image[int(height * 0.45) : height, : int(width * 0.48)]
        if roi.size:
            yield roi

    @staticmethod
    def _deadline_reached(absolute_deadline: float | None) -> bool:
        return absolute_deadline is not None and time.monotonic() >= absolute_deadline

    def decode_data_url(self, data_url: str, image_index: int | None = None) -> list[QrCodeResult]:
        if "," not in data_url:
            return []
        try:
            payload = base64.b64decode(data_url.split(",", 1)[1], validate=True)
            image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
            return self.decode(image, image_index) if image is not None else []
        except (ValueError, TypeError):
            return []

    def decode_with_rounds(
        self,
        image: np.ndarray,
        image_index: int | None = None,
        *,
        max_rounds: int = 3,
        absolute_deadline: float | None = None,
    ) -> tuple[list[QrCodeResult], list[RetryAttempt]]:
        attempts: list[RetryAttempt] = []
        for round_number in range(1, max(1, min(max_rounds, 3)) + 1):
            if self._deadline_reached(absolute_deadline):
                break
            started = time.monotonic()
            if round_number == 1:
                values = self.decode(
                    image,
                    image_index,
                    absolute_deadline=absolute_deadline,
                )
            elif round_number == 2:
                denoised = cv2.bilateralFilter(image, 7, 50, 50)
                sharpened = cv2.addWeighted(image, 1.8, denoised, -0.8, 0)
                values = self.decode(
                    sharpened,
                    image_index,
                    absolute_deadline=absolute_deadline,
                )
            else:
                values = []
                height, width = image.shape[:2]
                detector = cv2.QRCodeDetector()
                for row in range(2):
                    for column in range(2):
                        if self._deadline_reached(absolute_deadline):
                            break
                        tile = image[
                            row * height // 2 : (row + 1) * height // 2,
                            column * width // 2 : (column + 1) * width // 2,
                        ]
                        raw_values = self._decode_zxing(tile)
                        if not raw_values:
                            raw_values = self._decode_opencv(detector, tile)
                        values = [
                            QrCodeResult(image_index=image_index, raw_value=value)
                            for value in raw_values
                        ]
                        if values:
                            break
                    if values:
                        break
            attempts.append(RetryAttempt(target_id=str(image_index if image_index is not None else "qr"), stage="qr_decode", attempt_number=round_number, reason_code="decode_retry" if round_number > 1 else "initial_decode", strategy=f"round_{round_number}", result="succeeded" if values else "failed", duration_ms=max(0, int((time.monotonic() - started) * 1000))))
            if values:
                return values, attempts
        return [], attempts

    def decode_data_url_with_rounds(
        self,
        data_url: str,
        image_index: int | None = None,
        *,
        max_rounds: int = 3,
        absolute_deadline: float | None = None,
    ) -> tuple[list[QrCodeResult], list[RetryAttempt]]:
        if "," not in data_url:
            return [], []
        try:
            payload = base64.b64decode(data_url.split(",", 1)[1], validate=True)
            image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
        except (ValueError, TypeError):
            return [], []
        return self.decode_with_rounds(
            image,
            image_index,
            max_rounds=max_rounds,
            absolute_deadline=absolute_deadline,
        ) if image is not None else ([], [])


class QrWebVerifier:
    """Safely fetch and parse an official QR page."""

    def __init__(
        self,
        *,
        allowed_hosts: list[str],
        timeout_seconds: float = 8.0,
        max_bytes: int = 2_000_000,
        max_redirects: int = 2,
        transport: httpx.AsyncBaseTransport | httpx.BaseTransport | None = None,
    ) -> None:
        self.allowed_hosts = [host.lower().rstrip(".") for host in allowed_hosts]
        self.timeout = httpx.Timeout(timeout_seconds)
        self.max_bytes = max_bytes
        self.max_redirects = max_redirects
        self.transport = transport
        self._last_failure_retryable = False

    async def verify(self, url: str, image_index: int | None = None) -> QrCodeResult:
        if canonicalize_official_qr_url(url, self.allowed_hosts) is None:
            return QrCodeResult(
                image_index=image_index,
                raw_value=url,
                domain_valid=False,
                page_fields={},
            )
        async with self._client() as client:
            return await self._verify_once(client, url, image_index)

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            follow_redirects=False,
            timeout=self.timeout,
            transport=self.transport,
            verify=create_official_ssl_context(),
        )

    async def _verify_once(
        self,
        client: httpx.AsyncClient,
        url: str,
        image_index: int | None,
    ) -> QrCodeResult:
        self._last_failure_retryable = False
        canonical_url = canonicalize_official_qr_url(url, self.allowed_hosts)
        result = QrCodeResult(
            image_index=image_index,
            raw_value=url,
            url=canonical_url,
            domain_valid=canonical_url is not None,
        )
        if not result.domain_valid:
            result.page_fields = {}
            return result
        try:
            response = await self._fetch(client, canonical_url)
            result.accessible = True
            result.page_fields = extract_page_fields(response)
            result.status = "MATCH" if {"certificate_no", "vin"}.issubset(result.page_fields) else "REVIEW_REQUIRED"
        except httpx.HTTPStatusError as exc:
            self._last_failure_retryable = exc.response.status_code in {429, 500, 502, 503, 504}
            result.accessible = False
        except (httpx.HTTPError, ValueError, RuntimeError):
            result.accessible = False
        return result

    async def verify_with_retry(self, url: str, image_index: int | None = None, *, retry_count: int = 1) -> tuple[QrCodeResult, list[RetryAttempt]]:
        attempts: list[RetryAttempt] = []
        if canonicalize_official_qr_url(url, self.allowed_hosts) is None:
            result = await self.verify(url, image_index)
            attempts.append(RetryAttempt(target_id=str(image_index if image_index is not None else "qr"), stage="qr_web", attempt_number=1, reason_code="initial_request", strategy="official_page", result="failed", duration_ms=0))
            return result, attempts
        async with self._client() as client:
            for attempt_number in range(1, max(1, min(retry_count + 1, 2)) + 1):
                started = time.monotonic()
                result = await self._verify_once(client, url, image_index)
                retryable = self._last_failure_retryable
                attempts.append(RetryAttempt(target_id=str(image_index if image_index is not None else "qr"), stage="qr_web", attempt_number=attempt_number, reason_code="transient_http" if attempt_number > 1 else "initial_request", strategy="official_page", result="succeeded" if result.status == "MATCH" else "failed", duration_ms=max(0, int((time.monotonic() - started) * 1000))))
                if result.status == "MATCH" or not retryable:
                    return result, attempts
        return result, attempts

    async def _fetch(self, client: httpx.AsyncClient, url: str) -> str:
        current = url
        for _ in range(self.max_redirects + 1):
            if not validate_qr_url(current, self.allowed_hosts):
                raise ValueError("redirected outside allowlist")
            response = await client.get(current)
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise ValueError("redirect without location")
                current = str(response.url.join(location))
                continue
            response.raise_for_status()
            content = response.content
            if len(content) > self.max_bytes:
                raise ValueError("response too large")
            return content.decode(response.encoding or "utf-8", errors="replace")
        raise ValueError("too many redirects")
