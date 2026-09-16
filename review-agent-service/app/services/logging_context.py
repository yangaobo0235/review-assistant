"""审核链路结构化日志工具。

日志默认输出到 Uvicorn 控制台，使用稳定的 ``key=value`` 字段，便于
人工阅读和后续接入日志采集系统。这里只允许记录 ID、状态、数量和耗时
等诊断摘要，调用方不得传入身份证号、发票原文或图片内容。
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

_trace_id: ContextVar[str] = ContextVar("review_trace_id", default="-")
_job_id: ContextVar[str] = ContextVar("review_job_id", default="-")


def bind_log_context(*, trace_id: str | None = None, job_id: str | None = None) -> tuple[Any, Any]:
    """Bind IDs for the current request/task and return tokens for reset."""

    return (
        _trace_id.set(str(trace_id) if trace_id is not None else _trace_id.get()),
        _job_id.set(str(job_id) if job_id is not None else _job_id.get()),
    )


def reset_log_context(tokens: tuple[Any, Any]) -> None:
    _trace_id.reset(tokens[0])
    _job_id.reset(tokens[1])


def emit(logger: logging.Logger, event: str, *, level: int = logging.INFO, **fields: object) -> None:
    """Emit one readable, searchable structured event to the configured logger."""

    merged: dict[str, object] = {
        "event": event,
        "trace_id": _trace_id.get(),
        "job_id": _job_id.get(),
        **fields,
    }
    parts = []
    for key, value in merged.items():
        if value is None:
            value = "-"
        text = str(value).replace("\n", " ").replace("\r", " ")
        parts.append(f"{key}={text}")
    logger.log(level, "review_event %s", " ".join(parts))
