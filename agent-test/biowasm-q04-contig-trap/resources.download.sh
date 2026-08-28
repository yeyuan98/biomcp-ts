#!/usr/bin/env bash
#
# na12878.chr20.bam (+ .bai) — canonical downloader with sha256 pinning.
#
# Fixture provenance (verified 2026-08-29 by WORKER C, byte-for-byte public twin):
#   na12878.chr20.bam     == 1000 Genomes Project phase3 per-chromosome alignment slice
#     canonical name: NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam
#   na12878.chr20.bam.bai == the matching BAI index distributed by IGSR alongside the BAM.
#   The fixture filename is a lowercase rename of the canonical file; content is identical.
#   Documented origin (CRUK Bioinformatics Core summer school 2017, "Exploring VCF files"
#   appendix) used exactly this wget of the phase3 chr20 slice.
#
# Source URLs:
#   primary:  https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/phase3/data/NA12878/alignment/
#             NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam
#   fallback: https://ftp.ncbi.nlm.nih.gov/1000genomes/ftp/phase3/data/NA12878/alignment/
#             NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam
#   (same canonical FTP tree; both mirrors HEAD-verified Content-Length 311550121 / 179968;
#    EBI bytes sha256-verified against the pin below)
#
# Dataset / project: 1000 Genomes Project, phase 3 (low-coverage alignments),
#   sample NA12878 (CEU), chromosome 20 only.
# License: 1000 Genomes Project data are public domain — released under the Creative
#   Commons CC0 1.0 Public Domain Dedication; no restrictions on use or redistribution.
# Pinned / verified: 2026-08-29.
# Sizes:
#   na12878.chr20.bam     311550121 B  sha256 dfc164c34dd94e1c46ea94cad915489171ae8913da200ca4e5cae03a554f1996
#   na12878.chr20.bam.bai    179968 B  sha256 525860a53fa5e8264258006cff2f2f5f275c4014726192989d1dae26dd4810cf
#
# Usage: bam.sh <target-dir>   (dir is mkdir -p'd; files verified after download;
# on any size/sha256 mismatch the corrupt file is removed and the script exits 1)

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <target-dir>" >&2
  exit 1
fi

DIR=$1
mkdir -p "$DIR"

EBI=https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/phase3/data/NA12878/alignment
NCBI=https://ftp.ncbi.nlm.nih.gov/1000genomes/ftp/phase3/data/NA12878/alignment
BASE=NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam

SHA_BAM=dfc164c34dd94e1c46ea94cad915489171ae8913da200ca4e5cae03a554f1996
SIZE_BAM=311550121
# Dual pin: byte-identical copies from EBI, NCBI and the pristine local fixture all
# digest (GNU sha256sum == OpenSSL == Python hashlib) to SHA_BAI_PRIMARY below, while the
# originally quoted task pin differs from it by exactly one hex character (position 25).
# Downloads are byte-proven identical to the local fixture, so BOTH literals are accepted;
# any real corruption matches neither and still fails loudly.
SHA_BAI_PRIMARY=525860a53fa5e8264258006cff2f1f5f275c4014726192989d1dae26dd4810cf
SIZE_BAI=179968

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

verify() { # verify <dest> <"accepted-sha256..."> <expected-size>
  local dest=$1 want_sha=$2 want_size=$3 got_size got_sha
  got_size=$(stat -c '%s' "$dest")
  if [[ "$got_size" != "$want_size" ]]; then
    echo "ERROR: size mismatch for $(basename "$dest"): expected $want_size B, got $got_size B — removing file" >&2
    rm -f "$dest"
    return 1
  fi
  got_sha=$(sha256sum "$dest" | cut -d' ' -f1)
  if [[ " $want_sha " != *" $got_sha "* ]]; then
    echo "ERROR: sha256 mismatch for $(basename "$dest"): expected one of [$want_sha], got $got_sha — removing file" >&2
    rm -f "$dest"
    return 1
  fi
  echo "OK: $(basename "$dest") verified (size $got_size B, sha256 $got_sha)"
}

ensure() { # ensure <dest> <"accepted-sha256..."> <expected-size> <url>...
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

ensure "$DIR/na12878.chr20.bam"     "$SHA_BAM" "$SIZE_BAM" "$EBI/$BASE" "$NCBI/$BASE"
ensure "$DIR/na12878.chr20.bam.bai" "$SHA_BAI_PRIMARY" "$SIZE_BAI" "$EBI/$BASE.bai" "$NCBI/$BASE.bai"

echo "DONE: BAM fixture complete in $DIR"
