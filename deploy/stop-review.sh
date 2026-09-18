#!/usr/bin/env bash
set -euo pipefail

runtime_dir="/opt/review-assistant"
compose_file="${runtime_dir}/docker-compose.server.yml"
service_name="review-agent"

if [[ ! -f "${compose_file}" ]]; then
  echo "ERROR: missing ${compose_file}" >&2
  exit 1
fi

echo "Stopping Review Assistant..."
cd "${runtime_dir}"
docker compose -f "${compose_file}" stop "${service_name}"
docker compose -f "${compose_file}" ps "${service_name}"

echo "Review Assistant has stopped."

