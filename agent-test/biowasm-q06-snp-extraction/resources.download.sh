#!/usr/bin/env bash
#
# 1kg.chr22.vcf.gz (+ .tbi) — canonical downloader with sha256 pinning.
#
# Fixture provenance (verified 2026-08-29 by WORKER C, byte-for-byte public twin):
#   1kg.chr22.vcf.gz     == 1000 Genomes Project phase3 integrated variant call set,
#     release 20130502, chromosome 22, canonical name:
#     ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz
#   1kg.chr22.vcf.gz.tbi == the matching tabix index distributed by IGSR alongside the VCF.
#   The fixture filename is a rename of the canonical file; content is identical
#   (sha256 of the canonical URL download == pin below, EXACT match).
#
# Source URL (single canonical host):
#   https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/
#     ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz
#     ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz.tbi
#   NOTE: the NCBI mirror (ftp.ncbi.nlm.nih.gov/1000genomes/ftp/release/20130502/) hosts
#   the v5a revision of chr22 (214453750 B) — DIFFERENT content; deliberately NOT used.
#
# Dataset / project: 1000 Genomes Project, phase 3 final release (20130502 freeze),
#   2504 samples from 26 populations, chromosome 22 phased genotypes (GRCh37).
# License: 1000 Genomes Project data are public domain — released under the Creative
#   Commons CC0 1.0 Public Domain Dedication; no restrictions on use or redistribution.
# Pinned / verified: 2026-08-29.
# Sizes:
#   1kg.chr22.vcf.gz     205612353 B  sha256 a90c16c4ff2b3196476d506ae13cb3047fae8670163c7c932c4b0239aef3daf5
#   1kg.chr22.vcf.gz.tbi      36251 B  sha256 27de6b77af65d300bb968e8e372439deb949389e4395eb0dd251f9ba7d73bbed
#
# Usage: vcf.sh <target-dir>   (dir is mkdir -p'd; files verified after download;
# on any size/sha256 mismatch the corrupt file is removed and the script exits 1)

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <target-dir>" >&2
  exit 1
fi

DIR=$1
mkdir -p "$DIR"

EBI=https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502
BASE=ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz

SHA_VCF=a90c16c4ff2b3196476d506ae13cb3047fae8670163c7c932c4b0239aef3daf5
SIZE_VCF=205612353
SHA_TBI=27de6b77af65d300bb968e8e372439deb949389e4395eb0dd251f9ba7d73bbed
SIZE_TBI=36251

fetch() { # fetch <dest> <url>...
  local dest=$1 url
  shift
  for url in "$@"; do
    echo ">> downloading $(basename "$dest") from $url"
    if curl --fail --retry 3 --retry-delay 2 --connect-timeout 30 -C - -sS -o "$dest" "$url"; then
      return 0
    fi
    echo "   WARN: transfer from $url failed; partial file (if any) kept for -C - resume; trying next mirror" >&2
  done
  echo "ERROR: all mirrors failed for $(basename "$dest")" >&2
  return 1
}

verify() { # verify <dest> <expected-sha256> <expected-size>
  local dest=$1 want_sha=$2 want_size=$3 got_size got_sha
  got_size=$(stat -c '%s' "$dest")
  if [[ "$got_size" != "$want_size" ]]; then
    echo "ERROR: size mismatch for $(basename "$dest"): expected $want_size B, got $got_size B — removing file" >&2
    rm -f "$dest"
    return 1
  fi
  got_sha=$(sha256sum "$dest" | cut -d' ' -f1)
  if [[ "$got_sha" != "$want_sha" ]]; then
    echo "ERROR: sha256 mismatch for $(basename "$dest"): expected $want_sha, got $got_sha — removing file" >&2
    rm -f "$dest"
    return 1
  fi
  echo "OK: $(basename "$dest") verified (size $got_size B, sha256 $got_sha)"
}

ensure() { # ensure <dest> <expected-sha256> <expected-size> <url>...
  local dest=$1 want_sha=$2 want_size=$3 got_sha=""
  shift 3
  if [[ -f "$dest" ]]; then
    got_sha=$(sha256sum "$dest" | cut -d' ' -f1)
    if [[ "$got_sha" == "$want_sha" ]]; then
      echo "OK: $(basename "$dest") already present and verified — skipping download"
      return 0
    fi
    echo ">> $(basename "$dest") present but not verified yet; resuming/completing via curl -C -"
  fi
  fetch "$dest" "$@"
  verify "$dest" "$want_sha" "$want_size"
}

ensure "$DIR/1kg.chr22.vcf.gz"     "$SHA_VCF" "$SIZE_VCF" "$EBI/$BASE"
ensure "$DIR/1kg.chr22.vcf.gz.tbi" "$SHA_TBI" "$SIZE_TBI" "$EBI/$BASE.tbi"

echo "DONE: VCF fixture complete in $DIR"
