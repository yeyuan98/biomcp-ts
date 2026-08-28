# biowasm-prototype — evidence & design reference

Artifacts backing `docs/development/BIOWASM-INTEGRATION-PLAN.md` (§1 empirical
validation). These are throwaway research prototypes, kept for auditability and
as the design reference for the M2 engine implementation; they are deliberately
NOT wired into `src/`.

Environment: Node 22.23, Linux, 16 cores, 15 GB RAM (2026-08-27).

| File | Purpose |
|---|---|
| `harness.mjs` | Core prototype: module loader (XHR/self.location shims, `wasmBinary` injection), LazyNodeFS (fd-backed `pread` stream_ops + IO accounting), PROXYFS `/shared` sharing across tools, exec with stdio-stream reopen |
| `bgzf-check.mjs` | Independent BGZF block validator (pure Node zlib, CRC32+ISIZE per block) — used to prove downloads corrupt in transit and to exonerate the read layer |
| `heal.mjs` | Ranged re-fetch patcher for corrupt blocks (validated: one 64 KB patch healed a 312 MB BAM) |
| `bench-final.mjs` | samtools + bcftools benchmarks on real human data (NA12878 chr20 BAM 312 MB; 1000G chr22 VCF.gz 206 MB) |
| `bench-final.log` | Captured output of the final run (numbers cited in plan §1.2/§1.3) |
| `test5-samtools-real.mjs` | samtools-only benchmark incl. mpileup (plan §1.2 mpileup row) |
| `test8b-isolate.mjs` | bedtools scale/OOM bisection (V8 stdout-amplification discovery, plan §1.6) |
| `test11-worker.mjs` | worker_thread RPC + main-loop responsiveness + 2 ms mid-run `terminate()` (plan §1.5) |

Reproduction requires downloading datasets (~520 MB, see plan §1.1) into
`~/temp/biowasm/data/` and biowasm CDN assets (`samtools/1.21`, `bedtools/2.31.0`,
`bcftools/1.10`: `.js/.wasm/.data`) next to `harness.mjs`. Verify integrity with
`bgzf-check.mjs` (this machine's network corrupted ~1 block per ~300 MB).
