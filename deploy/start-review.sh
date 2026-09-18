#!/usr/bin/env bash
set -euo pipefail

upload_dir="/home/ubuntu/review-agent-deploy"
runtime_dir="/opt/review-assistant"
image_tar="${upload_dir}/review-agent-service-main.tar"
uploaded_compose="${upload_dir}/docker-compose.server.yml"
compose_file="${runtime_dir}/docker-compose.server.yml"
env_file="${runtime_dir}/review-agent-service/.env"
service_name="review-agent"
image_name="review-agent-service:main"
rollback_image="review-agent-service:rollback"
health_url="http://127.0.0.1:18110/health"

if [[ ! -s "${image_tar}" ]]; then
  echo "ERROR: missing or empty ${image_tar}" >&2
  echo "Upload the new TAR file before running this script." >&2
  exit 1
fi

if [[ ! -s "${env_file}" ]]; then
  echo "ERROR: missing or empty ${env_file}" >&2
  echo "The server .env file must not be deleted or overwritten." >&2
  exit 1
fi

if [[ -s "${uploaded_compose}" ]]; then
  echo "Installing the uploaded Docker Compose configuration..."
  cp "${uploaded_compose}" "${compose_file}"
fi

if [[ ! -s "${compose_file}" ]]; then
  echo "ERROR: missing or empty ${compose_file}" >&2
  exit 1
fi

echo "Saving the current image as ${rollback_image}..."
docker image rm "${rollback_image}" >/dev/null 2>&1 || true
if docker image inspect "${image_name}" >/dev/null 2>&1; then
  docker tag "${image_name}" "${rollback_image}"
fi

echo "Loading ${image_tar}..."
docker load -i "${image_tar}"

if ! docker image inspect "${image_name}" >/dev/null 2>&1; then
  echo "ERROR: ${image_tar} did not provide ${image_name}" >&2
  exit 1
fi

echo "Starting Review Assistant..."
cd "${runtime_dir}"
docker compose -f "${compose_file}" up -d --no-build --force-recreate "${service_name}"

echo "Waiting for the health endpoint..."
for attempt in {1..20}; do
  if curl --fail --silent --show-error "${health_url}" >/dev/null; then
    echo "Review Assistant started successfully."
    echo "Health: ${health_url}"
    docker compose -f "${compose_file}" ps "${service_name}"
    exit 0
  fi
  sleep 3
done

echo "ERROR: Review Assistant did not become healthy." >&2
echo "Recent logs:" >&2
docker compose -f "${compose_file}" logs --tail=100 "${service_name}" >&2
echo "Rollback image retained as ${rollback_image}." >&2
exit 1

