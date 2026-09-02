#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "${1}" ]]; then
  echo "Usage: scripts/vendor-simforge-oss.sh <git-ref>" >&2
  exit 2
fi

REF="$1"
SOURCE_DIR="${SIMFORGE_OSS_DIR:-/home/path/simforge-oss}"
REPO_URL="https://github.com/SimForgeinc/simforge-oss.git"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/vendor/simforge-oss"
WORK="$(mktemp -d)"
CHECKOUT="${WORK}/simforge-oss"
trap 'rm -rf "${WORK}"' EXIT

if [[ -d "${SOURCE_DIR}/.git" ]]; then
  echo "Cloning local SimForge OSS checkout: ${SOURCE_DIR}"
  git clone --quiet --no-hardlinks "${SOURCE_DIR}" "${CHECKOUT}"
else
  echo "Local checkout not found; cloning ${REPO_URL}"
  git clone --quiet "${REPO_URL}" "${CHECKOUT}"
fi

git -C "${CHECKOUT}" checkout --quiet --detach "${REF}"
COMMIT="$(git -C "${CHECKOUT}" rev-parse HEAD)"

packages=(engine compiler maps training-env viewer asset-catalog scenario)
filters=()
for package in "${packages[@]}"; do
  filters+=(--filter "@simforge-oss/${package}...")
done

pnpm --pm-on-fail=ignore --dir "${CHECKOUT}" install --frozen-lockfile
pnpm --pm-on-fail=ignore --dir "${CHECKOUT}" "${filters[@]}" build

rm -rf "${DEST}"
mkdir -p "${DEST}"
for package in "${packages[@]}"; do
  pnpm --pm-on-fail=ignore --dir "${CHECKOUT}/packages/${package}" pack --pack-destination "${DEST}" >/dev/null
done

node - "${DEST}" "${REF}" "${COMMIT}" "${CHECKOUT}" "${packages[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [dest, ref, commit, checkout, ...packages] = process.argv.slice(2);
const versions = {};
for (const packageName of packages) {
  const manifest = JSON.parse(fs.readFileSync(path.join(checkout, 'packages', packageName, 'package.json'), 'utf8'));
  versions[manifest.name] = manifest.version;
}
fs.writeFileSync(path.join(dest, 'LOCK.json'), `${JSON.stringify({ ref, commit, packages: versions }, null, 2)}\n`);
NODE

printf 'Vendored SimForge OSS %s (%s)\n' "${REF}" "${COMMIT}"
for archive in "${DEST}"/*.tgz; do
  size="$(( $(stat -c %s "${archive}") / 1024 ))"
  printf '  %s (%s KiB)\n' "$(basename "${archive}")" "${size}"
done
