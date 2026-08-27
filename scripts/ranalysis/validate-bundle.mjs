#!/usr/bin/env node
// Golden numeric validation for a freshly built r-wasm-mirror bundle.
// Boots webR against the bundle served over a loopback HTTP server, installs
// the analysis stack, and runs a hardened synthetic differential-expression
// benchmark (library-size variation, per-gene dispersion, bidirectional
// effects, BH false-positive-rate null) through DESeq2, edgeR, and limma.
//
// Usage: validate-bundle.mjs --dir <bundle-repo-dir>
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
  }
  if (!args.dir) throw new Error('--dir <bundle-repo-dir> is required');
  return args;
}

const { dir } = parseArgs();
const root = resolve(dir);
if (!existsSync(join(root, 'bin', 'emscripten', 'contrib', '4.6', 'PACKAGES'))) {
  throw new Error(`not a mirror repo dir: ${root}`);
}

const MIME = { '.gz': 'application/gzip', '.tgz': 'application/gzip', '.rds': 'application/octet-stream', '.data': 'application/octet-stream' };
const server = createServer((req, res) => {
  const p = resolve(join(root, decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')));
  if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'text/plain', 'content-length': statSync(p).size });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const mirrorUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`[validate] serving ${root} at ${mirrorUrl}`);

const { WebR } = await import('webr');
const webR = new WebR();
await webR.init();
console.log(`[validate] ${await webR.evalR('R.version.string').then((r) => r.toString())}`);

const shelter = await new webR.Shelter();
const FAILURES = [];
function check(name, cond, detail) {
  console.log(`[validate] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) FAILURES.push(name);
}

const out = await shelter.captureR(`
options(repos = c(MIRROR = ${JSON.stringify(mirrorUrl)}))
suppressWarnings(webr::install(c("DESeq2", "edgeR", "limma", "jsonlite"), repos = getOption("repos")))
paste0("installed=", length(rownames(installed.packages())))
`);
{
  const installReport = await out.result.toString();
  const installed = Number(installReport.match(/installed=(\d+)/)?.[1] ?? 0);
  check('analysis packages install', installed >= 60, installReport);
}

const res = await shelter.captureR(`
suppressMessages({library(DESeq2); library(edgeR); library(limma); library(jsonlite)})

# Hardened simulation: per-sample library sizes, per-gene dispersion,
# bidirectional fold changes, known truth.
set.seed(2026)
ngenes <- 2000
nsamples <- 6
grp <- factor(rep(c("ctl", "trt"), each = 3))
lib <- runif(nsamples, 0.7, 1.3)
mu <- 10^rnorm(ngenes, 2, 1)
size_gene <- exp(rnorm(ngenes, log(6), 0.5))
fc <- rep(1, ngenes)
de_up <- sample(ngenes, 100)
de_down <- sample(setdiff(seq_len(ngenes), de_up), 100)
fc[de_up] <- 4
fc[de_down] <- 0.25
counts <- vapply(seq_len(nsamples), function(j) {
  rnbinom(ngenes, mu = mu * if (j <= 3) 1 else fc, size = size_gene) * round(lib[j] * 100)
}, numeric(ngenes))
mode(counts) <- "integer"
rownames(counts) <- sprintf("ENSG%08d", seq_len(ngenes))

truth <- rep(0, ngenes); truth[de_up] <- 1; truth[de_down] <- -1

cd <- data.frame(condition = grp, row.names = colnames(counts))
run <- function(framework) {
  if (framework == "deseq2") {
    dds <- DESeqDataSetFromMatrix(counts, DataFrame(cd), ~ condition)
    res0 <- results(DESeq(dds, quiet = TRUE))
    r <- list(padj = res0$padj, lfc = res0$log2FoldChange)
  } else if (framework == "edger") {
    y <- DGEList(counts = counts, group = grp)
    y <- calcNormFactors(y)
    y <- estimateDisp(y, model.matrix(~ grp), robust = TRUE)
    t <- glmQLFTest(glmQLFit(y, model.matrix(~ grp), robust = TRUE), coef = 2)
    r <- list(padj = p.adjust(t$table$PValue, "BH"), lfc = t$table$logFC)
  } else {
    y <- calcNormFactors(DGEList(counts = counts))
    v <- voom(y, model.matrix(~ grp), plot = FALSE)
    fit <- eBayes(lmFit(v, model.matrix(~ grp)))
    r <- list(padj = topTable(fit, coef = 2, number = Inf, sort.by = "none")$adj.P.Val,
              lfc = fit$coefficients[, 2])
  }
  list(padj = r$padj, lfc = r$lfc)
}
direction_ok <- function(lfc) {
  lfc <- as.numeric(lfc)
  sum(lfc[de_up] > 0, na.rm = TRUE) / length(de_up) > 0.9 &&
    sum(lfc[de_down] < 0, na.rm = TRUE) / length(de_down) > 0.9
}
recover <- function(padj) sum(padj < 0.05, na.rm = TRUE)
fpr <- function(padj, truth) {
  null <- truth == 0
  sum(padj[null] < 0.05, na.rm = TRUE) / sum(null)
}

r1 <- run("deseq2"); r2 <- run("edger"); r3 <- run("limma")

ye <- DGEList(counts = counts, group = grp)
ye <- calcNormFactors(ye)
ye <- estimateDisp(ye)
ete <- exactTest(ye, pair = c("ctl", "trt"))
re <- list(padj = p.adjust(ete$table$PValue, "BH"), lfc = ete$table$logFC)
cat("limma up:", sum(as.numeric(r3$lfc)[de_up] > 0), "down:", sum(as.numeric(r3$lfc)[de_down] < 0), "\n")
cat("edger up:", sum(as.numeric(r2$lfc)[de_up] > 0), "down:", sum(as.numeric(r2$lfc)[de_down] < 0), "\n")
top100 <- function(padj) order(padj, na.last = NA)[1:100]
j12 <- length(intersect(top100(r1$padj), top100(r2$padj))) / 100
j13 <- length(intersect(top100(r1$padj), top100(r3$padj))) / 100

# Null-only run for FPR
counts0 <- vapply(seq_len(nsamples), function(j) rnbinom(ngenes, mu = mu * round(lib[j] * 100), size = size_gene), numeric(ngenes))
mode(counts0) <- "integer"
rownames(counts0) <- rownames(counts)
dds0 <- DESeq(DESeqDataSetFromMatrix(counts0, DataFrame(cd), ~ condition), quiet = TRUE)
fpr0 <- fpr(results(dds0)$padj, truth)

jsonlite::toJSON(list(
  deseq2 = list(sig = recover(r1$padj), dir = direction_ok(r1$lfc), fpr = fpr0),
  edger = list(sig = recover(r2$padj), dir = direction_ok(r2$lfc)),
  edger_exact = list(sig = recover(re$padj), dir = direction_ok(re$lfc)),
  limma = list(sig = recover(r3$padj), dir = direction_ok(r3$lfc)),
  jaccard_deseq2_edger = j12,
  jaccard_deseq2_limma = j13,
  versions = list(deseq2 = as.character(packageVersion("DESeq2")),
                  edger = as.character(packageVersion("edgeR")),
                  limma = as.character(packageVersion("limma")))
), auto_unbox = TRUE, digits = NA)
`);

const v = JSON.parse(await res.result.toString());
console.log('[validate] results:', JSON.stringify(v, null, 1));

check('DESeq2 recovers >= 60 DE genes', v.deseq2.sig >= 60, `sig=${v.deseq2.sig}`);
check('edgeR recovers >= 60 DE genes', v.edger.sig >= 60, `sig=${v.edger.sig}`);
check('limma recovers >= 60 DE genes', v.limma.sig >= 60, `sig=${v.limma.sig}`);
check('DESeq2 directions correct', v.deseq2.dir === true);
check('edgeR directions correct', v.edger.dir === true);
check('edgeR exact recovers >= 60 DE genes', v.edger_exact.sig >= 60, `sig=${v.edger_exact.sig}`);
check('edgeR exact directions correct', v.edger_exact.dir === true);
check('limma directions correct', v.limma.dir === true);
check('DESeq2/edgeR top-100 Jaccard > 0.5', v.jaccard_deseq2_edger > 0.5, `J=${v.jaccard_deseq2_edger}`);
check('DESeq2/limma top-100 Jaccard > 0.5', v.jaccard_deseq2_limma > 0.5, `J=${v.jaccard_deseq2_limma}`);
check('null BH FPR <= 10%', v.deseq2.fpr <= 0.1, `FPR=${v.deseq2.fpr}`);

await shelter.purge();
await webR.close();
server.close();
if (FAILURES.length) {
  console.error(`[validate] FAILED: ${FAILURES.join(', ')}`);
  process.exit(1);
}
console.log('[validate] all checks passed');
