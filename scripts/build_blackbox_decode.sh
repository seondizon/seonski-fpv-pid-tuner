#!/usr/bin/env bash
#
# Build the `blackbox_decode` binary from betaflight/blackbox-tools.
#
# LICENSING NOTE: blackbox-tools is GPL-3.0 licensed (see
# docs/research/licenses.md#betaflight-blackbox-tools). We clone/build it
# into vendor/blackbox-tools (gitignored -- never committed to this repo)
# and invoke the resulting binary as an external subprocess from our own
# code. We build ONLY the `blackbox_decode` target, which has zero external
# library dependencies; we deliberately do not build `blackbox_render`
# (needs libcairo/libfreetype, and we have no use for it).
#
# Usage: scripts/build_blackbox_decode.sh
#
set -euo pipefail

REPO_URL="https://github.com/betaflight/blackbox-tools"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/blackbox-tools"
BIN_PATH="${VENDOR_DIR}/obj/blackbox_decode"

err() {
    echo "ERROR: $*" >&2
}

require_cmd() {
    local cmd="$1"
    local hint="$2"
    if ! command -v "${cmd}" >/dev/null 2>&1; then
        err "required tool '${cmd}' not found on PATH. ${hint}"
        exit 1
    fi
}

require_cmd git "Install git (e.g. 'apt install git' / 'brew install git') and re-run this script."
require_cmd make "Install build tools (e.g. 'apt install build-essential' / Xcode command line tools on macOS) and re-run this script."

if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
    err "no C compiler (cc/gcc/clang) found on PATH. Install a C toolchain (e.g. 'apt install build-essential' / Xcode command line tools on macOS) and re-run this script."
    exit 1
fi

mkdir -p "${REPO_ROOT}/vendor"

if [ -d "${VENDOR_DIR}/.git" ]; then
    echo "vendor/blackbox-tools already present, skipping clone."
elif [ -d "${VENDOR_DIR}" ]; then
    err "${VENDOR_DIR} exists but is not a git repository. Remove it and re-run this script if you want a fresh clone."
    exit 1
else
    echo "Cloning ${REPO_URL} into ${VENDOR_DIR} (shallow, single branch)..."
    if ! git clone --depth 1 --single-branch "${REPO_URL}" "${VENDOR_DIR}"; then
        err "git clone of ${REPO_URL} failed."
        exit 1
    fi
fi

echo "Building blackbox_decode (obj/blackbox_decode target only, no blackbox_render/cairo/freetype dependency)..."
if ! (cd "${VENDOR_DIR}" && make obj/blackbox_decode); then
    err "build failed. See compiler output above."
    exit 1
fi

if [ ! -x "${BIN_PATH}" ]; then
    err "build reported success but expected binary not found at ${BIN_PATH}."
    exit 1
fi

echo "Built blackbox_decode successfully:"
echo "${BIN_PATH}"
