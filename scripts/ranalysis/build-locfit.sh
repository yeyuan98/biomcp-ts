#!/usr/bin/env bash
# Build the locfit wasm binary with rwasm inside the official webR container.
#
# locfit has no public wasm build (missing from repo.r-wasm.org and r-universe).
# The official rwasm container currently loses CC/CFLAGS to R CMD INSTALL's
# make command line, so we bind-mount a patched webr-vars.mk (see
# webr-vars-locfit.mk next to this script).
#
# Usage: build-locfit.sh <output-dir> [locfit-source-version]
set -euo pipefail

OUT_DIR="${1:?usage: build-locfit.sh <output-dir> [version]}"
LOCfit_VERSION="${2:-1.5-9.12}"
IMAGE="${LOCfit_IMAGE:-ghcr.io/r-wasm/webr@sha256:2bd309d7a4ea1daed82b6fdb8e325b0de715fcd8592c5b6f3b3b88366e70cb76}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

mkdir -p "${OUT_DIR}"

curl -fsSL --retry 3 --max-time 120 \
  "https://cran.r-project.org/src/contrib/locfit_${LOCfit_VERSION}.tar.gz" \
  -o "${WORK_DIR}/locfit.tar.gz"
mkdir -p "${WORK_DIR}/src"
tar -xzf "${WORK_DIR}/locfit.tar.gz" -C "${WORK_DIR}/src"

cat > "${WORK_DIR}/build.R" <<'RSCRIPT'
library(rwasm)
build("/work/src/locfit", out_dir = "/output")
cat("LOCfit_BUILD_DONE\n")
RSCRIPT

docker run --rm \
  -v "${OUT_DIR}:/output" \
  -v "${WORK_DIR}:/work" \
  -v "${SCRIPT_DIR}/webr-vars-locfit.mk:/opt/R/4.6.0/lib/R/library/rwasm/webr-vars.mk:ro" \
  -w /output \
  "${IMAGE}" \
  R -f /work/build.R > "${WORK_DIR}/build.log" 2>&1 || {
    cat "${WORK_DIR}/build.log" >&2
    exit 1
  }

tail -3 "${WORK_DIR}/build.log" >&2
ls -la "${OUT_DIR}" | grep locfit >&2
