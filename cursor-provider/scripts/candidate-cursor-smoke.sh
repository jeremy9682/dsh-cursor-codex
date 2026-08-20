#!/usr/bin/env bash
set -euo pipefail

: "${DSH_CANDIDATE_ROOT:?promotion must provide DSH_CANDIDATE_ROOT}"
: "${DSH_CANDIDATE_BASE_URL:?set DSH_CANDIDATE_BASE_URL to the disposable candidate host}"
: "${DSH_CANDIDATE_TREE_SHA256:?promotion must provide DSH_CANDIDATE_TREE_SHA256}"
: "${DSH_GATE_MANIFEST:?promotion must provide DSH_GATE_MANIFEST}"
: "${DSH_CURSOR_MODEL:?set DSH_CURSOR_MODEL from the disposable candidate catalog}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/candidate-dsh-smoke.mjs"
