#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing dependency: $1" >&2
    exit 1
  }
}

need aws

AWS_REGION="${AWS_REGION:-us-west-1}"
export AWS_REGION

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-v2x-backend-state-${ACCOUNT_ID}-${AWS_REGION}}"
STATE_BASE_URL="https://${STATE_BUCKET}.s3.${AWS_REGION}.amazonaws.com"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

if ! aws s3api head-bucket --bucket "${STATE_BUCKET}" >/dev/null 2>&1; then
  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${STATE_BUCKET}" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "${STATE_BUCKET}" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
fi

aws s3api put-public-access-block \
  --bucket "${STATE_BUCKET}" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

aws s3api put-bucket-acl \
  --bucket "${STATE_BUCKET}" \
  --acl private >/dev/null 2>&1 || true

if aws s3api get-bucket-policy --bucket "${STATE_BUCKET}" >/dev/null 2>&1; then
  aws s3api delete-bucket-policy --bucket "${STATE_BUCKET}" >/dev/null
fi

printf '%s' '{"objects":[],"twin_status":{"status":"disconnected","objects_tracked":0,"cameras_active":0,"last_heartbeat":null},"updated_at":null}' > "${WORKDIR}/state.json"
printf '%s' '{"road_network":[]}' > "${WORKDIR}/map-data.json"

aws s3api put-object \
  --bucket "${STATE_BUCKET}" \
  --key "api/state.json" \
  --content-type "application/json" \
  --cache-control "max-age=2" \
  --body "${WORKDIR}/state.json" >/dev/null

aws s3api put-object \
  --bucket "${STATE_BUCKET}" \
  --key "api/map-data.json" \
  --content-type "application/json" \
  --cache-control "max-age=3600" \
  --body "${WORKDIR}/map-data.json" >/dev/null

echo "Done."
echo "State bucket: ${STATE_BUCKET}"
echo "State base URL: ${STATE_BASE_URL}"
echo "Public access: blocked"
