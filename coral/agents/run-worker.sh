#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -n "${REFINERY_NODE_BIN:-}" ]]; then
  NODE_BIN="${REFINERY_NODE_BIN}"
elif [[ -x "${HOME}/.nvm/versions/node/v24.10.0/bin/node" ]]; then
  NODE_BIN="${HOME}/.nvm/versions/node/v24.10.0/bin/node"
else
  NODE_BIN="node"
fi

cd "${REPO_ROOT}"
if [[ -f "${REPO_ROOT}/dist/coral/worker.js" ]]; then
  exec "${NODE_BIN}" dist/coral/worker.js "$@"
fi
exec "${NODE_BIN}" src/coral/worker.ts "$@"
