import { rEngine } from './engine.js';
import { toColdataCsv, toCountsCsv, type CanonicalAnalysisRequest } from './validate.js';
import { deseq2Script, edgerScript, limmaScript } from './rscripts.js';
import { renderAnalysisTable, renderSessionInfo, type AnalysisPayload } from './render.js';

export interface Deseq2Options {
  alpha: number;
  fitType: 'parametric' | 'local' | 'mean';
  shrink: boolean;
}

export interface EdgerOptions {
  test: 'qlm' | 'exact';
}

async function runAnalysis(script: string, request: CanonicalAnalysisRequest, title: string): Promise<{ text: string; isJson: boolean }> {
  const inputs = [
    { name: 'counts.csv', content: toCountsCsv(request) },
    { name: 'coldata.csv', content: toColdataCsv(request) },
  ];
  const { payload } = await rEngine.runScript(script, inputs);
  const analysisPayload = payload as unknown as AnalysisPayload;
  if (request.format === 'json') {
    const out: Record<string, unknown> = {
      summary: analysisPayload.summary,
      columns: analysisPayload.columns,
      top: analysisPayload.top,
      warnings: analysisPayload.warnings,
    };
    if (analysisPayload.full_tsv) {
      const { gzipSync } = await import('node:zlib');
      out.full_results_b64_tsv = gzipSync(Buffer.from(analysisPayload.full_tsv, 'utf8')).toString('base64');
    }
    return { text: JSON.stringify(out, null, 2), isJson: true };
  }
  return { text: renderAnalysisTable(title, analysisPayload), isJson: false };
}

export async function runDeseq2(request: CanonicalAnalysisRequest, options: Deseq2Options): Promise<{ text: string; isJson: boolean }> {
  return runAnalysis(deseq2Script(request, options), request, 'DESeq2');
}

export async function runEdger(request: CanonicalAnalysisRequest, options: EdgerOptions): Promise<{ text: string; isJson: boolean }> {
  return runAnalysis(edgerScript(request, options), request, 'edgeR');
}

export async function runLimma(request: CanonicalAnalysisRequest): Promise<{ text: string; isJson: boolean }> {
  return runAnalysis(limmaScript(request), request, 'limma-voom');
}

export async function runSessionInfo(): Promise<{ text: string; isJson: boolean }> {
  const { payload } = await rEngine.sessionInfo();
  const extra = {
    mirror_endpoint: rEngine.mirrorEndpoint() ?? 'not running',
    node_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  return { text: renderSessionInfo(payload as Record<string, unknown>, extra), isJson: false };
}
