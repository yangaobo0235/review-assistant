FROM python:3.11-slim-bookworm AS builder

ARG UV_VERSION=0.12.11

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

RUN python -m pip install --no-cache-dir "uv==${UV_VERSION}"

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app


FROM python:3.11-slim-bookworm AS runtime

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system review-agent \
    && useradd --system --gid review-agent --home-dir /app review-agent

WORKDIR /app

COPY --from=builder --chown=review-agent:review-agent /app /app

USER review-agent

EXPOSE 8010

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010"]
