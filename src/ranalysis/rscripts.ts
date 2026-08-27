import type { CanonicalAnalysisRequest } from './validate.js';

const SHARED_PREFIX = `
counts_df <- read.csv("/input/counts.csv", check.names = FALSE, row.names = 1, stringsAsFactors = FALSE)
coldata_df <- read.csv("/input/coldata.csv", check.names = FALSE, row.names = 1, stringsAsFactors = FALSE)
counts <- as.matrix(counts_df)
storage.mode(counts) <- "integer"
chr_cols <- names(coldata_df)[vapply(coldata_df, is.character, logical(1))]
for (cl in chr_cols) coldata_df[[cl]] <- factor(coldata_df[[cl]])
design_formula <- as.formula(__DESIGN__)
mm <- model.matrix(design_formula, data = coldata_df)
mm_cols <- colnames(mm)
warn_log <- character(0)

try_num <- function(expr) tryCatch({
  v <- expr
  if (length(v) == 1 && is.finite(v)) v else NULL
}, error = function(e) NULL)

build_output <- function(summary_list, full, top_n, include_full) {
  full$gene <- rownames(full)
  full <- full[, c("gene", setdiff(colnames(full), "gene")), drop = FALSE]
  ord <- order(full$padj, full$pvalue, na.last = NA)
  full <- full[ord, , drop = FALSE]
  top_df <- full[seq_len(min(top_n, nrow(full))), , drop = FALSE]
  tsv <- NULL
  if (include_full) {
    lines <- c(paste(colnames(full), collapse = "\t"))
    if (nrow(full) > 0) lines <- c(lines, apply(full, 1, paste, collapse = "\t"))
    tsv <- paste(lines, collapse = "\n")
  }
  out <- list(
    summary = summary_list,
    columns = colnames(full),
    top = top_df,
    full_tsv = tsv,
    warnings = warn_log
  )
  jsonlite::toJSON(out, auto_unbox = TRUE, na = "null", null = "null", digits = NA, dataframe = "rows")
}
`;

function contrastSetup(req: CanonicalAnalysisRequest, opts: { nativeCoefNames?: boolean } = {}): string {
  const c = req.contrast
    ? `list(${JSON.stringify(req.contrast.variable)}, ${JSON.stringify(req.contrast.numerator)}, ${JSON.stringify(req.contrast.denominator)})`
    : 'NULL';
  const coef = req.coef ? JSON.stringify(req.coef) : 'NULL';
  return `
contrast_spec <- ${c}
coef_request <- ${coef}
contrast_vector <- NULL
coef_name <- NULL
if (!is.null(contrast_spec)) {
  vn <- contrast_spec[[1]]
  num_col <- paste0(vn, contrast_spec[[2]])
  den_col <- paste0(vn, contrast_spec[[3]])
  num_hit <- num_col %in% mm_cols
  den_hit <- den_col %in% mm_cols
  if (num_hit && den_hit) {
    contrast_vector <- rep(0, length(mm_cols))
    contrast_vector[mm_cols == num_col] <- 1
    contrast_vector[mm_cols == den_col] <- -1
    coef_name <- num_col
  } else if (num_hit) {
    coef_name <- num_col
  } else if (den_hit) {
    contrast_vector <- rep(0, length(mm_cols))
    contrast_vector[mm_cols == den_col] <- -1
    coef_name <- den_col
  } else {
    stop("contrast levels '", num_col, "' / '", den_col, "' not found among model matrix columns: ", paste(mm_cols, collapse = ", "))
  }
} else if (!is.null(coef_request)) {
  if (${opts.nativeCoefNames ? 'FALSE' : '!(coef_request %in% mm_cols)'}) {
    stop("coef '", coef_request, "' not found among model matrix columns: ", paste(mm_cols, collapse = ", "))
  }
  coef_name <- coef_request
} else {
  coef_name <- mm_cols[ncol(mm)]
}
`;
}

export function contrastLabel(req: CanonicalAnalysisRequest): string {
  if (req.contrast) {
    return `${req.contrast.variable}: ${req.contrast.numerator} vs ${req.contrast.denominator}`;
  }
  if (req.coef) return `coef ${req.coef}`;
  return 'last term of design';
}

interface Deseq2Options {
  alpha: number;
  fitType: 'parametric' | 'local' | 'mean';
  shrink: boolean;
}

export function deseq2Script(req: CanonicalAnalysisRequest, opts: Deseq2Options): string {
  const contrast = req.contrast
    ? `c(${JSON.stringify(req.contrast.variable)}, ${JSON.stringify(req.contrast.numerator)}, ${JSON.stringify(req.contrast.denominator)})`
    : 'NULL';
  return (
    SHARED_PREFIX.replace('__DESIGN__', JSON.stringify('~' + req.design)) +
    contrastSetup(req, { nativeCoefNames: true }) +
    `
main <- function() {
  suppressMessages(library(DESeq2))
  dds <- DESeqDataSetFromMatrix(countData = counts, colData = coldata_df, design = design_formula)
  dds <- DESeq(dds, quiet = TRUE, fitType = ${JSON.stringify(opts.fitType)})
  rn <- resultsNames(dds)
  res <- if (!is.null(${contrast})) {
    results(dds, contrast = ${contrast}, alpha = ${opts.alpha})
  } else {
    use_name <- NULL
    if (!is.null(coef_request)) {
      if (coef_request %in% rn) {
        use_name <- coef_request
      } else {
        for (n in rn) {
          if (gsub("_", "", sub("_vs_.*$", "", n)) == coef_request) { use_name <- n; break }
        }
      }
      if (is.null(use_name)) {
        stop("coef '", coef_request, "' not found among DESeq2 results names: ", paste(rn, collapse = ", "))
      }
    } else {
      use_name <- rn[length(rn)]
    }
    coef_name <<- use_name
    results(dds, name = use_name, alpha = ${opts.alpha})
  }
  ${
    opts.shrink
      ? `res <- tryCatch(lfcShrink(dds, res = res, type = "normal"), error = function(e) {
    warn_log <<- c(warn_log, paste("lfcShrink(type='normal') failed; returning unshrunk LFC:", conditionMessage(e)))
    res
  })`
      : ''
  }
  q <- round(as.numeric(quantile(dispersions(dds), c(0.25, 0.5, 0.75), na.rm = TRUE)), 4)
  summary_list <- list(
    framework = "DESeq2",
    package_version = as.character(packageVersion("DESeq2")),
    design = ${JSON.stringify(req.design)},
    contrast = ${JSON.stringify(contrastLabel(req))},
    n_genes_input = nrow(counts),
    n_genes_tested = nrow(res),
    n_samples = ncol(counts),
    alpha = ${opts.alpha},
    fit_type = ${JSON.stringify(opts.fitType)},
    lfc_shrunk = ${opts.shrink ? 'TRUE' : 'FALSE'},
    size_factors = as.list(round(sizeFactors(dds), 4)),
    dispersion_quantiles = as.list(setNames(q, c("q25", "q50", "q75"))),
    filter_threshold = try_num(metadata(res)$filterThreshold),
    n_outliers_replaced = try_num(sum(mcols(dds)$replace, na.rm = TRUE)),
    n_padj_na = sum(is.na(res$padj)),
    n_significant = sum(res$padj < ${opts.alpha}, na.rm = TRUE)
  )
  full <- data.frame(
    base_mean = res$baseMean,
    log2fc = res$log2FoldChange,
    lfc_se = res$lfcSE,
    stat = res$stat,
    pvalue = res$pvalue,
    padj = res$padj,
    row.names = rownames(res)
  )
  list(summary_list = summary_list, full = full)
}

result <- withCallingHandlers(main(), warning = function(w) {
  warn_log <<- c(warn_log, conditionMessage(w))
  invokeRestart("muffleWarning")
})
build_output(result$summary_list, result$full, ${req.topN}, ${req.includeFull ? 'TRUE' : 'FALSE'})
`
  );
}

interface EdgerOptions {
  test: 'qlm' | 'exact';
}

export function edgerScript(req: CanonicalAnalysisRequest, opts: EdgerOptions): string {
  return (
    SHARED_PREFIX.replace('__DESIGN__', JSON.stringify('~' + req.design)) +
    contrastSetup(req) +
    `
main <- function() {
  suppressMessages(library(edgeR))
  y <- DGEList(counts = counts, samples = coldata_df)
  keep <- filterByExpr(y, design = mm)
  n_filtered <- sum(!keep)
  y <- y[keep, , keep.lib.sizes = FALSE]
  y <- calcNormFactors(y)
  ${
    opts.test === 'exact'
      ? `if (is.null(contrast_spec)) stop("test='exact' requires an explicit contrast (variable/numerator/denominator); use test='qlm' for default contrasts.")
  vn <- contrast_spec[[1]]
  if (!is.factor(coldata_df[[vn]])) stop("test='exact' requires a categorical (string) contrast variable.")
  lev <- levels(coldata_df[[vn]])
  if (length(lev) != 2) stop("test='exact' requires the contrast variable to have exactly 2 levels (observed: ", paste(lev, collapse = ", "), "); use test='qlm' instead.")
  y$samples$group <- coldata_df[[vn]]
  y <- estimateDisp(y)
  et <- exactTest(y, pair = c(contrast_spec[[3]], contrast_spec[[2]]))
  tb <- et$table
  full <- data.frame(
    log_cpm = tb$logCPM,
    log2fc = tb$logFC,
    pvalue = tb$PValue,
    padj = p.adjust(tb$PValue, method = "BH"),
    row.names = rownames(tb)
  )`
      : `y <- estimateDisp(y, design = mm, robust = TRUE)
  fit <- glmQLFit(y, design = mm, robust = TRUE)
  tst <- if (!is.null(contrast_vector)) {
    glmQLFTest(fit, contrast = contrast_vector)
  } else {
    glmQLFTest(fit, coef = which(mm_cols == coef_name))
  }
  tb <- tst$table
  full <- data.frame(
    log_cpm = tb$logCPM,
    log2fc = tb$logFC,
    f_stat = tb$F,
    pvalue = tb$PValue,
    padj = p.adjust(tb$PValue, method = "BH"),
    row.names = rownames(tb)
  )`
  }
  summary_list <- list(
    framework = "edgeR",
    package_version = as.character(packageVersion("edgeR")),
    design = ${JSON.stringify(req.design)},
    contrast = ${JSON.stringify(contrastLabel(req))},
    n_genes_input = nrow(counts),
    n_genes_tested = nrow(full),
    n_genes_filtered = n_filtered,
    n_samples = ncol(counts),
    test = ${JSON.stringify(opts.test)},
    norm_factors = { nf <- round(y$samples$norm.factors, 4); names(nf) <- colnames(counts); as.list(nf) },
    common_dispersion = try_num(y$common.dispersion),
    n_padj_na = sum(is.na(full$padj)),
    n_significant = sum(full$padj < 0.05, na.rm = TRUE)
  )
  list(summary_list = summary_list, full = full)
}

result <- withCallingHandlers(main(), warning = function(w) {
  warn_log <<- c(warn_log, conditionMessage(w))
  invokeRestart("muffleWarning")
})
build_output(result$summary_list, result$full, ${req.topN}, ${req.includeFull ? 'TRUE' : 'FALSE'})
`
  );
}

export function limmaScript(req: CanonicalAnalysisRequest): string {
  return (
    SHARED_PREFIX.replace('__DESIGN__', JSON.stringify('~' + req.design)) +
    contrastSetup(req) +
    `
main <- function() {
  suppressMessages(library(limma))
  suppressMessages(library(edgeR))
  y <- DGEList(counts = counts)
  keep <- filterByExpr(y, design = mm)
  n_filtered <- sum(!keep)
  y <- y[keep, , keep.lib.sizes = FALSE]
  y <- calcNormFactors(y)
  v <- voom(y, design = mm, plot = FALSE)
  fit <- lmFit(v, design = mm)
  if (!is.null(contrast_vector)) fit <- contrasts.fit(fit, contrasts = matrix(contrast_vector, ncol = 1, dimnames = list(mm_cols, coef_name)))
  fit <- eBayes(fit)
  if (!(coef_name %in% colnames(fit$coefficients))) {
    stop("coefficient '", coef_name, "' not found; available: ", paste(colnames(fit$coefficients), collapse = ", "))
  }
  tt <- topTable(fit, coef = coef_name, number = Inf, adjust.method = "BH", sort.by = "none")
  full <- data.frame(
    ave_expr = tt$AveExpr,
    log2fc = tt$logFC,
    t_stat = tt$t,
    pvalue = tt$P.Value,
    padj = tt$adj.P.Val,
    row.names = rownames(tt)
  )
  summary_list <- list(
    framework = "limma-voom",
    package_version = as.character(packageVersion("limma")),
    design = ${JSON.stringify(req.design)},
    contrast = ${JSON.stringify(contrastLabel(req))},
    coef = coef_name,
    n_genes_input = nrow(counts),
    n_genes_tested = nrow(full),
    n_genes_filtered = n_filtered,
    n_samples = ncol(counts),
    norm_factors = { nf <- round(y$samples$norm.factors, 4); names(nf) <- colnames(counts); as.list(nf) },
    n_padj_na = sum(is.na(full$padj)),
    n_significant = sum(full$padj < 0.05, na.rm = TRUE)
  )
  list(summary_list = summary_list, full = full)
}

result <- withCallingHandlers(main(), warning = function(w) {
  warn_log <<- c(warn_log, conditionMessage(w))
  invokeRestart("muffleWarning")
})
build_output(result$summary_list, result$full, ${req.topN}, ${req.includeFull ? 'TRUE' : 'FALSE'})
`
  );
}

export const SESSION_INFO_SCRIPT = `
info <- list(
  r_version = R.version.string,
  platform = R.version$platform,
  packages = as.list(vapply(c("DESeq2", "edgeR", "limma", "jsonlite"),
    function(p) tryCatch(as.character(packageVersion(p)), error = function(e) "not installed"), "")),
  lib_paths = paste(.libPaths(), collapse = " ; "),
  memory_mb = round(sum(gc()[, 2])),
  installed_count = length(rownames(installed.packages()))
)
jsonlite::toJSON(info, auto_unbox = TRUE, digits = NA)
`;
