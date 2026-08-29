#!/usr/bin/env node
/*
 * agent-test/run.mjs — runner + objective grader for the biowasm agent-usability
 * test suite (plan rev 7 §2/§3).
 *
 * Single-file plain ESM JavaScript. node:stdlib only (fs, path, crypto,
 * child_process, process); zero npm dependencies.
 *
 * Pipeline per (test, rep):
 *   1. Discover per-test dirs with a test.json (--only/--filter select, --list prints index).
 *   2. Provision externalData pins (bytes-then-streaming-sha256). Missing data +
 *      resources.download.sh -> run script (max 2 attempts), else SKIP.
 *   3. Prepare .runs/<TEST>/<YYYYMMDD-HHMMSS>-r<rep>/, copy the test's
 *      opencode.json into the run dir BEFORE spawn, export AGENT_TEST_BUNDLE /
 *      AGENT_TEST_DATA, spawn `opencode run --dir <run-dir> --auto <prompt>
 *      --format json [--model ID]`; stdout+stderr appended to log.jsonl.
 *      Timeout: SIGTERM -> 3 s -> SIGKILL -> harness ERROR.
 *   4. Parse NDJSON (skip unparseable lines): tool_use events (ignore pending),
 *      assistant text events, terminal step_finish(reason=="stop"), APIError
 *      events -> global stop-loss (remaining tests INTERRUPTED, exit 2).
 *   5. Grade checks (13 types, plan §3) -> result.json per rep.
 *   6. Report: .runs/summary.json + stdout table; .runs/provenance.json once
 *      per invocation.
 *
 * Resume: a rep is reused (no spawn, re-graded from the existing log) when a
 * prior dir for that rep index has a log ending in a terminal step_finish(stop)
 * AND a result.json, unless --force.
 *
 * Exit codes: 0 = all selected tests PASS (or SKIP-only / PASS*); 1 = >=1 FAIL;
 * 2 = harness ERROR / INTERRUPTED (takes precedence over 1).
 *
 * Spec-ambiguity resolutions are marked AMBIGUITY: in comments where a
 * normative choice was required; all are also listed in the worker report.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const AGENT_ROOT = path.dirname(path.resolve(process.argv[1]));
const REPO_ROOT = path.dirname(AGENT_ROOT);
const RUNS_DIR = path.join(AGENT_ROOT, ".runs");
const DEFAULT_TIMEOUT_MS = 300000;
const TERM_GRACE_MS = 3000;
const PROVISION_SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;

class UsageError extends Error {}
class HarnessError extends Error {}

/* ================================================================ SECTION: CLI */

function parseArgs(argv) {
  const a = {
    only: null,
    filter: null,
    reps: 1,
    force: false,
    dataRoot: null,
    model: null,
    timeout: null,
    dryRun: false,
    list: false,
    help: false,
  };
  const need = (flag, v) => {
    if (v === undefined) throw new UsageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case "--only": a.only = need(t, argv[++i]); break;
      case "--filter": a.filter = need(t, argv[++i]); break;
      case "--reps": a.reps = Number(need(t, argv[++i])); break;
      case "--force": a.force = true; break;
      case "--data-root": a.dataRoot = need(t, argv[++i]); break;
      case "--model": a.model = need(t, argv[++i]); break;
      case "--timeout": a.timeout = Number(need(t, argv[++i])); break;
      case "--dry-run": a.dryRun = true; break;
      case "--list": a.list = true; break;
      case "--help": case "-h": a.help = true; break;
      default: throw new UsageError(`unknown argument: ${t}`);
    }
  }
  if (!Number.isInteger(a.reps) || a.reps < 1) throw new UsageError("--reps must be an integer >= 1");
  if (a.timeout !== null && (!Number.isFinite(a.timeout) || a.timeout <= 0)) throw new UsageError("--timeout must be a positive number of ms");
  if (a.only && a.filter) throw new UsageError("--only and --filter are mutually exclusive");
  return a;
}

function usage() {
  return [
    "usage: node agent-test/run.mjs [options]",
    "  --only <id>       run a single test (dir name or test.json id)",
    "  --filter <glob>   run tests whose id matches glob (* and ?)",
    "  --reps <N>        repetitions per test (default 1)",
    "  --force           re-run even if a complete prior rep exists",
    "  --data-root <DIR> externalData root (default $AGENT_TEST_DATA or agent-test/.runs/data)",
    "  --model <ID>      passed to `opencode run --model` (optional)",
    "  --timeout <ms>    per-rep timeout override (default: test timeoutMs else 300000)",
    "  --dry-run         provision + parse tests, never spawn opencode",
    "  --list            print the test index table and exit",
    "exit codes: 0 all PASS/PASS*/SKIP-only; 1 any FAIL; 2 harness ERROR/INTERRUPTED",
  ].join("\n");
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

/* ============================================================ SECTION: discovery */

function loadTestEntry(name) {
  const dir = path.join(AGENT_ROOT, name);
  const tj = path.join(dir, "test.json");
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  if (!fs.existsSync(tj)) return null;
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(tj, "utf8"));
  } catch (e) {
    return { id: name, dirName: name, dir, error: `unparseable test.json: ${e.message}` };
  }
  const id = typeof spec.id === "string" && spec.id ? spec.id : name;
  if (typeof spec.prompt !== "string" || !spec.prompt) {
    return { id, dirName: name, dir, error: "test.json missing string field: prompt" };
  }
  if (!Array.isArray(spec.checks)) {
    return { id, dirName: name, dir, error: "test.json missing array field: checks" };
  }
  const timeoutMs = spec.timeoutMs ?? spec.timeout ?? null;
  return {
    id,
    dirName: name,
    dir,
    spec,
    level: spec.level ?? null,
    purpose: spec.purpose ?? "",
    externalData: Array.isArray(spec.externalData) ? spec.externalData : [],
    hasDownloadScript: fs.existsSync(path.join(dir, "resources.download.sh")),
    timeoutMs: typeof timeoutMs === "number" ? timeoutMs : null,
  };
}

function discoverTests() {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(AGENT_ROOT, { withFileTypes: true });
  } catch (e) {
    throw new HarnessError(`cannot read agent-test root ${AGENT_ROOT}: ${e.message}`);
  }
  for (const de of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const t = loadTestEntry(de.name);
    if (t) out.push(t);
  }
  return out;
}

function selectTests(tests, args) {
  let sel = tests;
  if (args.only) {
    sel = tests.filter((t) => t.id === args.only || t.dirName === args.only);
    if (sel.length === 0) throw new HarnessError(`no test matches --only ${args.only}`);
  } else if (args.filter) {
    const re = globToRegExp(args.filter);
    sel = tests.filter((t) => re.test(t.id) || re.test(t.dirName));
    if (sel.length === 0) throw new HarnessError(`no test matches --filter ${args.filter}`);
  }
  return sel;
}

function printListTable(tests) {
  const cols = [
    ["ID", 34], ["LEVEL", 5], ["PURPOSE", 46], ["EXT", 3], ["DL", 2], ["TIMEOUT", 8],
  ];
  const head = cols.map(([h, w]) => h.padEnd(w)).join("  ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const t of tests) {
    const purpose = t.error ? `ERROR: ${t.error}` : String(t.purpose ?? "");
    const row = [
      (t.id ?? "").slice(0, 34).padEnd(34),
      String(t.level ?? "-").slice(0, 5).padEnd(5),
      purpose.slice(0, 46).padEnd(46),
      String(t.externalData?.length ?? 0).padEnd(3),
      (t.hasDownloadScript ? "y" : "n").padEnd(2),
      String(t.timeoutMs ?? DEFAULT_TIMEOUT_MS).padEnd(8),
    ].join("  ");
    console.log(row);
  }
}

/* =========================================================== SECTION: provisioning */

async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const rs = createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.on("error", reject);
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

function statFile(file) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ?? null;
}

async function verifyEntry(dataRoot, entry) {
  if (typeof entry?.path !== "string" || !entry.path) return { ok: false, reason: "entry missing path" };
  if (typeof entry.sha256 !== "string" || entry.sha256.length !== 64) return { ok: false, reason: `entry ${entry.path}: sha256 must be a 64-hex pin` };
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0) return { ok: false, reason: `entry ${entry.path}: bytes must be a non-negative integer` };
  const file = path.resolve(dataRoot, entry.path);
  const st = statFile(file);
  if (!st || !st.isFile()) return { ok: false, reason: "missing", file };
  if (st.size !== entry.bytes) return { ok: false, reason: `size mismatch (expected ${entry.bytes}, got ${st.size})`, file };
  const hex = await sha256File(file);
  if (hex.toLowerCase() !== entry.sha256.toLowerCase()) return { ok: false, reason: `sha256 mismatch (expected ${entry.sha256}, got ${hex})`, file };
  return { ok: true, file };
}

function runScriptToLog(script, dataRoot, logPath) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logPath, "a");
    fs.writeSync(fd, `\n[${new Date().toISOString()}] running: bash ${script} ${dataRoot}\n`);
    const child = spawn("bash", [script, dataRoot], { cwd: path.dirname(script), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    const finish = (code, signal, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(timer);
      fs.writeSync(fd, `\n[${new Date().toISOString()}] script exit: code=${code} signal=${signal ?? "-"}${timedOut ? " (timed out)" : ""}\n`);
      fs.closeSync(fd);
      resolve({ code, signal, timedOut });
    };
    child.stdout.on("data", (c) => fs.writeSync(fd, c));
    child.stderr.on("data", (c) => fs.writeSync(fd, c));
    child.on("error", (e) => {
      fs.writeSync(fd, `spawn error: ${e.message}\n`);
      finish(-1, null, false);
    });
    child.on("close", (code, signal) => finish(code, signal, false));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS);
    }, PROVISION_SCRIPT_TIMEOUT_MS);
    let killTimer;
  });
}

async function provisionTest(test, dataRoot) {
  if (!test.externalData.length) return { status: "ok", notes: [] };
  const testRunsDir = path.join(RUNS_DIR, test.dirName);
  fs.mkdirSync(testRunsDir, { recursive: true });
  const logPath = path.join(testRunsDir, "provision.log");
  const logNote = (msg) => { try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
  const notes = [];
  const note = (msg) => { notes.push(msg); logNote(msg); };
  for (const entry of test.externalData) {
    let v = await verifyEntry(dataRoot, entry);
    if (v.ok) continue;
    if (v.reason !== "missing") note(`${entry.path}: ${v.reason}`);
    const script = path.join(test.dir, "resources.download.sh");
    if (!test.hasDownloadScript) {
      /* AMBIGUITY: file present but hash-mismatched with no download script ->
       * SKIP (never FAIL); treat like the missing+no-script path. */
      return { status: "skip", reason: `externalData "${entry.path}" ${v.reason} and no resources.download.sh`, notes };
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      note(`${entry.path}: ${v.reason}; running resources.download.sh (attempt ${attempt})`);
      const r = await runScriptToLog(script, dataRoot, logPath);
      if (r.timedOut) return { status: "error", reason: `resources.download.sh timed out for ${entry.path}`, notes };
      v = await verifyEntry(dataRoot, entry);
      if (v.ok) break;
    }
    if (!v.ok) return { status: "error", reason: `externalData "${entry.path}" failed verification after 2 download attempts: ${v.reason}`, notes };
  }
  return { status: "ok", notes };
}

/* ============================================================ SECTION: session exec */

function timestampDirName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readLogFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseLog(text);
}

function findResumeDir(test, rep) {
  const testRunsDir = path.join(RUNS_DIR, test.dirName);
  let dirs = [];
  try {
    dirs = fs.readdirSync(testRunsDir).sort().reverse();
  } catch {
    return null;
  }
  const complete = [];
  for (const name of dirs) {
    const m = name.match(/^(\d{8}-\d{6})(?:-\d+)?-r(\d+)$/);
    if (!m || Number(m[2]) !== rep) continue;
    const dir = path.join(testRunsDir, name);
    const log = path.join(dir, "log.jsonl");
    const result = path.join(dir, "result.json");
    if (!fs.existsSync(log) || !fs.existsSync(result)) continue;
    const parsed = readLogFile(log);
    if (parsed && parsed.endsWithStop) complete.push(dir);
  }
  return complete[0] ?? null;
}

function dropIncompleteRepDirs(test, rep) {
  const testRunsDir = path.join(RUNS_DIR, test.dirName);
  let dirs = [];
  try {
    dirs = fs.readdirSync(testRunsDir);
  } catch {
    return;
  }
  for (const name of dirs) {
    const m = name.match(/^(\d{8}-\d{6})(?:-\d+)?-r(\d+)$/);
    if (!m || Number(m[2]) !== rep) continue;
    const dir = path.join(testRunsDir, name);
    const log = path.join(dir, "log.jsonl");
    const result = path.join(dir, "result.json");
    const logOk = (() => {
      const p = readLogFile(log);
      return !!(p && p.endsWithStop);
    })();
    if (!(logOk && fs.existsSync(result))) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSession(test, rep, args, dataRoot) {
  return new Promise((resolve) => {
    const testRunsDir = path.join(RUNS_DIR, test.dirName);
    fs.mkdirSync(testRunsDir, { recursive: true });
    dropIncompleteRepDirs(test, rep);
    const ts = timestampDirName();
    let runDir = path.join(testRunsDir, `${ts}-r${rep}`);
    for (let k = 2; fs.existsSync(runDir); k++) runDir = path.join(testRunsDir, `${ts}-${k}-r${rep}`);
    fs.mkdirSync(runDir, { recursive: true });

    const cfgSrc = path.join(test.dir, "opencode.json");
    if (fs.existsSync(cfgSrc)) {
      // Copy with literal {env:} substitution (belt-and-braces fallback: the
      // committed file keeps {env:...} placeholders, the run-dir copy works
      // even if an opencode upgrade drops native command/env substitution).
      const envBundle = path.join(REPO_ROOT, "dist", "bundle.js");
      const envData = path.resolve(dataRoot);
      let cfgText = fs.readFileSync(cfgSrc, "utf8");
      cfgText = cfgText
        .replaceAll("{env:AGENT_TEST_BUNDLE}", envBundle)
        .replaceAll("{env:AGENT_TEST_DATA}", envData);
      fs.writeFileSync(path.join(runDir, "opencode.json"), cfgText);
    }

    const prompt = test.spec.prompt.split("{DATA_DIR}").join(path.resolve(dataRoot));
    fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt + "\n");

    const logPath = path.join(runDir, "log.jsonl");
    const fd = fs.openSync(logPath, "a");
    const timeoutMs = args.timeout ?? test.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const argv = ["run", "--dir", runDir, "--auto", prompt, "--format", "json"];
    if (args.model) argv.push("--model", args.model);
    const env = {
      ...process.env,
      AGENT_TEST_BUNDLE: path.join(REPO_ROOT, "dist", "bundle.js"),
      AGENT_TEST_DATA: path.resolve(dataRoot),
    };
    const child = spawn("opencode", argv, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });

    let timedOut = false;
    let settled = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS);
    }, timeoutMs);

    const finish = (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fs.closeSync(fd);
      resolve({ runDir, logPath, timedOut, spawnError: spawnError ?? null });
    };
    child.stdout.on("data", (c) => { try { fs.writeSync(fd, c); } catch {} });
    child.stderr.on("data", (c) => { try { fs.writeSync(fd, c); } catch {} });
    child.on("error", (e) => finish(e));
    child.on("close", () => finish(null));
  });
}

/* ============================================================= SECTION: NDJSON parse */

function isApiErrorEvent(ev) {
  if (ev?.type !== "error") return false;
  const err = ev.error ?? ev.part?.error ?? ev.data ?? null;
  if (!err || typeof err !== "object") return false;
  if (err.name === "APIError") return true;
  const sc = err.data?.statusCode ?? err.statusCode ?? null;
  return Number.isFinite(Number(sc)) && Number(sc) >= 400;
}

function parseLog(text) {
  const events = [];
  let parsedCount = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    parsedCount++;
    events.push(ev);
  }
  const toolCalls = [];
  const texts = [];
  let endsWithStop = false;
  let lastApiError = null;
  let lastWasTerminalStop = false;
  for (const ev of events) {
    lastWasTerminalStop = false;
    if (ev.type === "tool_use") {
      const part = ev.part ?? {};
      const state = part.state ?? {};
      const status = state.status;
      if (status === "pending") continue;
      toolCalls.push({
        tool: part.tool,
        status: status ?? null,
        input: state.input ?? null,
        output: state.output ?? null,
        error: state.error ?? null,
      });
    } else if (ev.type === "text" && typeof ev.part?.text === "string") {
      /* AMBIGUITY: real `opencode run --format json` logs (verified against
       * ~/temp/biowasm-e2e/.../M1-unsorted-depth.json) emit assistant text as
       * top-level type "text" with part.text; no role field. "message"-typed
       * part.text events are accepted as well for forward compatibility. */
      if (ev.part.text) texts.push(ev.part.text);
    } else if (ev.type === "message" && typeof ev.part?.text === "string") {
      if (ev.part.text) texts.push(ev.part.text);
    } else if (ev.type === "step_finish") {
      if (ev.part?.reason === "stop") lastWasTerminalStop = true;
    } else if (isApiErrorEvent(ev)) {
      lastApiError = ev.error ?? ev.part?.error ?? ev.data ?? null;
    }
  }
  endsWithStop = lastWasTerminalStop && events.length > 0;
  return { events, parsedCount, toolCalls, texts, endsWithStop, apiError: lastApiError };
}

/* ================================================================= SECTION: grader */

function toText(v) {
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function resolveToolRef(parsed, name) {
  if (typeof name !== "string" || name.length === 0) return { error: "empty tool name" };
  const distinct = [...new Set(parsed.toolCalls.map((c) => c.tool))].filter((t) => t === name || t.endsWith(name));
  if (distinct.length === 0) return { missing: true };
  if (distinct.length > 1) return { error: `ambiguous tool ref "${name}" matches [${distinct.join(", ")}] — use the full name` };
  return { full: distinct[0], calls: parsed.toolCalls.filter((c) => c.tool === distinct[0]) };
}

function parseOccurrence(ref) {
  const m = String(ref).match(/^(.*)#(\d+)$/);
  if (!m) return { name: String(ref), occ: 1 };
  return { name: m[1], occ: Number(m[2]) };
}

function getSource(parsed, source) {
  const src = source ?? "final";
  if (src === "final") {
    return parsed.texts.length ? { ok: true, value: parsed.texts[parsed.texts.length - 1] } : { ok: false };
  }
  if (src === "assistant") {
    return parsed.texts.length ? { ok: true, value: parsed.texts.join("\n") } : { ok: false };
  }
  if (typeof src !== "string") return { error: `source must be a string, got ${typeof src}` };
  if (src.startsWith("tool:")) {
    const rest = src.slice(5);
    if (rest === "*") {
      const parts = parsed.toolCalls.map((c) => (c.status === "completed" ? c.output : c.error)).filter((v) => v !== null && v !== undefined);
      return parts.length ? { ok: true, value: parts.map(toText).join("\n") } : { ok: false };
    }
    const { name, occ } = parseOccurrence(rest);
    const r = resolveToolRef(parsed, name);
    if (r.error) return { error: r.error };
    if (r.missing) return { ok: false };
    if (!Number.isInteger(occ) || occ < 1) return { error: `invalid occurrence in source "${src}"` };
    const call = r.calls[occ - 1];
    if (!call) return { ok: false };
    const v = call.status === "completed" ? call.output : call.error;
    if (v === null || v === undefined) return { ok: false };
    return { ok: true, value: v };
  }
  if (src.startsWith("args:")) {
    const { name, occ } = parseOccurrence(src.slice(6));
    const r = resolveToolRef(parsed, name);
    if (r.error) return { error: r.error };
    if (r.missing) return { ok: false };
    if (!Number.isInteger(occ) || occ < 1) return { error: `invalid occurrence in source "${src}"` };
    const call = r.calls[occ - 1];
    if (!call || call.input === null || call.input === undefined) return { ok: false };
    return { ok: true, value: call.input };
  }
  return { error: `unknown source "${src}"` };
}

function walkPath(obj, p) {
  if (typeof p !== "string" || p.length === 0) return { error: `malformed path ${JSON.stringify(p)}` };
  const segs = p.split(".");
  if (segs.some((s) => s === "")) return { error: `malformed path "${p}" (empty segment)` };
  let cur = obj;
  for (const s of segs) {
    if (cur === null || cur === undefined) return { missing: true };
    if (Array.isArray(cur)) {
      const i = Number(s);
      if (!Number.isInteger(i) || String(i) !== s || i < 0 || i >= cur.length) return { missing: true };
      cur = cur[i];
    } else if (typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, s)) return { missing: true };
      cur = cur[s];
    } else {
      return { missing: true };
    }
  }
  return { value: cur };
}

const NUM_TOKEN_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
function extractNumbers(text) {
  const out = [];
  for (const m of toText(text).matchAll(NUM_TOKEN_RE)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function textFragments(text) {
  return toText(text)
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .filter((f) => f.trim().length > 0);
}

function compileContext(context) {
  if (context === undefined || context === null) return null;
  if (typeof context !== "string" || context.length === 0) return { error: "context must be a non-empty regex string" };
  try {
    return { re: new RegExp(context) };
  } catch (e) {
    return { error: `invalid context regex ${JSON.stringify(context)}: ${e.message}` };
  }
}

function numbersInContext(text, context) {
  const c = compileContext(context);
  if (c && c.error) return c;
  const frags = context === undefined || context === null
    ? [toText(text)]
    : textFragments(text).filter((f) => c.re.test(f));
  return { nums: frags.flatMap(extractNumbers) };
}

function existsValue(v) {
  if (v === null || v === undefined) return false;
  if (v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (typeof v === "object" && Object.keys(v).length === 0) return false;
  return true;
}

function getOccurrence(check, parsed, key = "tool") {
  const r = resolveToolRef(parsed, check[key]);
  if (r.error) return r;
  if (r.missing) return { missing: true };
  const occ = check.occurrence ?? 1;
  if (!Number.isInteger(occ) || occ < 1) return { error: `invalid occurrence ${JSON.stringify(check.occurrence)} (must be integer >= 1)` };
  const call = r.calls[occ - 1];
  if (!call) return { missing: true, note: `occurrence ${occ} of ${r.full} not found (${r.calls.length} call(s))` };
  return { call, full: r.full, occ };
}

const result = (check, status, detail) => ({
  type: check?.type ?? "?",
  desc: typeof check?.desc === "string" && check.desc ? check.desc : null,
  status,
  detail,
});

function describeCheck(check) {
  return typeof check?.desc === "string" && check.desc ? check.desc : `<${check?.type ?? "?"}>`;
}

function evalCheck(check, parsed) {
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    return result(check, "error", "check is not an object");
  }
  try {
    const fn = CHECK_TYPES[check.type];
    if (!fn) return result(check, "error", `unknown check type ${JSON.stringify(check.type)}`);
    return fn(check, parsed);
  } catch (e) {
    return result(check, "error", `grader exception: ${e.message}`);
  }
}

function checkToolSeq(check, parsed) {
  const seq = check.seq;
  if (!Array.isArray(seq) || seq.length === 0) return result(check, "error", "tool_seq requires non-empty seq: [[tool, status|*], ...]");
  const norm = [];
  for (const e of seq) {
    if (!Array.isArray(e) || e.length < 1 || typeof e[0] !== "string" || e[0].length === 0) {
      return result(check, "error", `malformed tool_seq entry ${JSON.stringify(e)}`);
    }
    const st = e[1] ?? "*";
    if (st !== "*" && st !== "completed" && st !== "error") {
      return result(check, "error", `invalid status ${JSON.stringify(st)} in tool_seq entry (completed|error|*)`);
    }
    norm.push([e[0], st]);
  }
  const mode = check.mode ?? "subsequence";
  if (mode !== "subsequence" && mode !== "exact") return result(check, "error", `invalid tool_seq mode ${JSON.stringify(check.mode)}`);
  const stream = parsed.toolCalls.filter((c) => typeof c.tool === "string" && c.tool.startsWith("biomcp_"));
  const matches = (call, [name, st]) => (call.tool === name || call.tool.endsWith(name)) && (st === "*" || call.status === st);
  let ok;
  if (mode === "exact") {
    ok = stream.length === norm.length && norm.every((entry, i) => matches(stream[i], entry));
  } else {
    ok = true;
    let i = 0;
    for (const entry of norm) {
      while (i < stream.length && !matches(stream[i], entry)) i++;
      if (i >= stream.length) { ok = false; break; }
      i++;
    }
  }
  const streamStr = stream.map((c) => `${c.tool}:${c.status}`).join(" -> ") || "(empty)";
  return result(check, ok ? "pass" : "fail",
    ok ? `tool_seq ${mode} matched (${stream.length} biomcp call(s))`
       : `tool_seq ${mode} not matched; biomcp stream: ${streamStr}`);
}

function checkGroup(check, parsed) {
  const hasAny = Array.isArray(check.anyOf);
  const hasAll = Array.isArray(check.allOf);
  if (hasAny === hasAll) return result(check, "error", "group requires exactly one of anyOf|allOf (non-empty array)");
  const arms = hasAny ? check.anyOf : check.allOf;
  if (arms.length === 0) return result(check, "error", "group requires a non-empty anyOf/allOf array");
  const armResults = arms.map((a) => evalCheck(a, parsed));
  const summary = armResults.map((r, i) => `arm${i + 1}[${r.status}]${r.detail ? ` ${r.detail}` : ""}`).join("; ");
  if (hasAny) {
    if (armResults.some((r) => r.status === "pass")) {
      return { ...result(check, "pass", `anyOf matched: ${summary}`), arms: armResults };
    }
    if (armResults.every((r) => r.status === "error")) {
      return { ...result(check, "error", `anyOf: all arms ERROR: ${summary}`), arms: armResults };
    }
    return { ...result(check, "fail", `anyOf: no arm matched: ${summary}`), arms: armResults };
  }
  if (armResults.some((r) => r.status === "fail")) {
    return { ...result(check, "fail", `allOf: failing arm(s): ${summary}`), arms: armResults };
  }
  if (armResults.some((r) => r.status === "error")) {
    /* AMBIGUITY: spec defines ERROR-arm handling only for anyOf; for allOf an
     * ERROR arm with no failing arm propagates ERROR. */
    return { ...result(check, "error", `allOf: error arm(s): ${summary}`), arms: armResults };
  }
  return { ...result(check, "pass", `allOf matched: ${summary}`), arms: armResults };
}

function checkText(check, parsed) {
  const op = check.op ?? "contains";
  if (!["contains", "not_contains", "regex"].includes(op)) return result(check, "error", `invalid text op ${JSON.stringify(check.op)}`);
  if (typeof check.expect !== "string") return result(check, "error", "text requires string expect");
  const s = getSource(parsed, check.source);
  if (s.error) return result(check, "error", `source: ${s.error}`);
  if (!s.ok) return result(check, "fail", `missing source ${JSON.stringify(check.source ?? "final")}`);
  const hay = toText(s.value);
  let ok;
  if (op === "contains") ok = hay.includes(check.expect);
  else if (op === "not_contains") ok = !hay.includes(check.expect);
  else {
    try { ok = new RegExp(check.expect).test(hay); } catch (e) { return result(check, "error", `invalid regex: ${e.message}`); }
  }
  return result(check, ok ? "pass" : "fail",
    `${op} ${JSON.stringify(check.expect)} on ${JSON.stringify(check.source ?? "final")} (${hay.length} chars)`);
}

function checkNumberNear(check, parsed) {
  if (!Number.isFinite(Number(check.expect))) return result(check, "error", "number_near requires numeric expect");
  const expect = Number(check.expect);
  const tol = check.tolerance === undefined ? 0 : Number(check.tolerance);
  if (!Number.isFinite(tol) || tol < 0) return result(check, "error", "tolerance must be a finite number >= 0");
  const s = getSource(parsed, check.source);
  if (s.error) return result(check, "error", `source: ${s.error}`);
  if (!s.ok) return result(check, "fail", `missing source ${JSON.stringify(check.source ?? "final")}`);
  const r = numbersInContext(s.value, check.context);
  if (r.error) return result(check, "error", r.error);
  const ok = r.nums.some((n) => Math.abs(n - expect) <= tol);
  return result(check, ok ? "pass" : "fail",
    `${ok ? "found" : "no"} number within ${tol} of ${expect}${check.context ? ` in context ${JSON.stringify(check.context)}` : ""}; numbers: [${r.nums.slice(0, 12).join(", ")}${r.nums.length > 12 ? ", …" : ""}]`);
}

function checkTextNumberCount(check, parsed) {
  if (!Number.isFinite(Number(check.expect))) return result(check, "error", "text_number_count requires numeric expect");
  const expect = Number(check.expect);
  const tol = check.tolerance === undefined ? 0 : Number(check.tolerance);
  if (!Number.isFinite(tol) || tol < 0) return result(check, "error", "tolerance must be a finite number >= 0");
  /* AMBIGUITY: spec gives text_number_count no explicit source; plan §3 says the
   * shared source field defaults to "final". Honors explicit source, default final. */
  const s = getSource(parsed, check.source);
  if (s.error) return result(check, "error", `source: ${s.error}`);
  if (!s.ok) return result(check, "fail", `missing source ${JSON.stringify(check.source ?? "final")}`);
  const r = numbersInContext(s.value, check.context);
  if (r.error) return result(check, "error", r.error);
  const distinct = [...new Set(r.nums)];
  const ok = Math.abs(distinct.length - expect) <= tol;
  return result(check, ok ? "pass" : "fail",
    `${distinct.length} distinct number(s)${check.context ? ` in context ${JSON.stringify(check.context)}` : ""}, expected ${expect}±${tol}; got [${distinct.slice(0, 12).join(", ")}${distinct.length > 12 ? ", …" : ""}]`);
}

function checkArgs(check, parsed) {
  const op = check.op;
  if (!["equals", "regex", "contains", "exists"].includes(op)) return result(check, "error", `invalid args op ${JSON.stringify(check.op)}`);
  const g = getOccurrence(check, parsed);
  if (g.error) return result(check, "error", g.error);
  if (g.missing) return result(check, "fail", `no matching tool call: ${g.note ?? JSON.stringify(check.tool)}`);
  const input = g.call.input ?? {};
  if (typeof input !== "object" || Array.isArray(input)) return result(check, "fail", `call ${g.full}#${g.occ} input is not an object`);
  const w = walkPath(input, check.path);
  if (w.error) return result(check, "error", w.error);
  if (w.missing) return result(check, "fail", `path "${check.path}" missing in ${g.full}#${g.occ} input`);
  const v = w.value;
  if (op === "exists") {
    const ok = existsValue(v);
    return result(check, ok ? "pass" : "fail", `path "${check.path}" in ${g.full}#${g.occ}: ${ok ? "exists" : `empty/null (${toText(v)})`}`);
  }
  if (check.expect === undefined) return result(check, "error", `${op} requires expect`);
  if (op === "equals") {
    const ok = deepEqual(v, check.expect);
    return result(check, ok ? "pass" : "fail", `path "${check.path}" in ${g.full}#${g.occ}: ${JSON.stringify(v)} ${ok ? "==" : "!="} ${JSON.stringify(check.expect)}`);
  }
  const hay = toText(v);
  if (op === "contains") {
    const ok = hay.includes(String(check.expect));
    return result(check, ok ? "pass" : "fail", `path "${check.path}" in ${g.full}#${g.occ}: ${ok ? "contains" : "does not contain"} ${JSON.stringify(String(check.expect))}`);
  }
  try {
    const ok = new RegExp(String(check.expect)).test(hay);
    return result(check, ok ? "pass" : "fail", `path "${check.path}" in ${g.full}#${g.occ}: regex ${JSON.stringify(String(check.expect))} ${ok ? "matched" : "no match"}`);
  } catch (e) {
    return result(check, "error", `invalid regex: ${e.message}`);
  }
}

function checkArgsRel(check, parsed) {
  const op = check.op;
  if (!["lt", "le", "gt", "ge", "eq"].includes(op)) return result(check, "error", `invalid args_rel op ${JSON.stringify(check.op)}`);
  for (const k of ["occA", "occB"]) {
    if (!Number.isInteger(check[k]) || check[k] < 1) return result(check, "error", `args_rel requires integer ${k} >= 1`);
  }
  const r = resolveToolRef(parsed, check.tool);
  if (r.error) return result(check, "error", r.error);
  if (r.missing) return result(check, "fail", `no matching tool call: ${JSON.stringify(check.tool)}`);
  const pick = (occ) => r.calls[occ - 1];
  const a = pick(check.occA);
  const b = pick(check.occB);
  if (!a || !b) return result(check, "fail", `occurrences not found: occA=${check.occA}${a ? "" : " (missing)"} occB=${check.occB}${b ? "" : " (missing)"} of ${r.full} (${r.calls.length} call(s))`);
  const wa = walkPath(a.input ?? {}, check.path);
  const wb = walkPath(b.input ?? {}, check.path);
  if (wa.error) return result(check, "error", `occA: ${wa.error}`);
  if (wb.error) return result(check, "error", `occB: ${wb.error}`);
  if (wa.missing || wb.missing) return result(check, "fail", `path "${check.path}" missing in occA or occB input of ${r.full}`);
  const va = Number(wa.value);
  const vb = Number(wb.value);
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return result(check, "fail", `non-numeric value(s) at "${check.path}": occA=${JSON.stringify(wa.value)} occB=${JSON.stringify(wb.value)}`);
  const cmp = { lt: va < vb, le: va <= vb, gt: va > vb, ge: va >= vb, eq: va === vb }[op];
  const sym = { lt: "<", le: "<=", gt: ">", ge: ">=", eq: "==" }[op];
  return result(check, cmp ? "pass" : "fail",
    /* AMBIGUITY: natural A-op-B ordering (value(occA) OP value(occB)); see report
     * re: the Q12 spec-sheet example which reads as occB OP occA. */
    `${r.full} "${check.path}": occA(${check.occA})=${va} ${sym} occB(${check.occB})=${vb} -> ${cmp}`);
}

function checkJsonPath(check, parsed) {
  const op = check.op;
  if (!["equals", "near", "exists"].includes(op)) return result(check, "error", `invalid json_path op ${JSON.stringify(check.op)}`);
  const g = getOccurrence(check, parsed);
  if (g.error) return result(check, "error", g.error);
  if (g.missing) return result(check, "fail", `no matching tool call: ${g.note ?? JSON.stringify(check.tool)}`);
  const raw = g.call.output;
  if (raw === null || raw === undefined) return result(check, "fail", `${g.full}#${g.occ} has no output`);
  let obj;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return result(check, "fail", `${g.full}#${g.occ} output is not JSON`);
    }
  } else if (typeof raw === "object") {
    obj = raw;
  } else {
    return result(check, "fail", `${g.full}#${g.occ} output is not an object/string`);
  }
  const w = walkPath(obj, check.path);
  if (w.error) return result(check, "error", w.error);
  if (w.missing) return result(check, "fail", `path "${check.path}" missing in ${g.full}#${g.occ} output JSON`);
  const v = w.value;
  if (op === "exists") {
    const ok = existsValue(v);
    return result(check, ok ? "pass" : "fail", `json_path "${check.path}" in ${g.full}#${g.occ}: ${ok ? "exists" : `empty/null (${toText(v)})`}`);
  }
  if (check.expect === undefined) return result(check, "error", `${op} requires expect`);
  if (op === "equals") {
    const ok = deepEqual(v, check.expect);
    return result(check, ok ? "pass" : "fail", `json_path "${check.path}": ${JSON.stringify(v)} ${ok ? "==" : "!="} ${JSON.stringify(check.expect)}`);
  }
  const tol = check.tolerance === undefined ? 0 : Number(check.tolerance);
  if (!Number.isFinite(tol) || tol < 0) return result(check, "error", "tolerance must be a finite number >= 0");
  const nv = Number(v);
  const ne = Number(check.expect);
  if (!Number.isFinite(nv) || !Number.isFinite(ne)) return result(check, "fail", `non-numeric value at "${check.path}": ${JSON.stringify(v)}`);
  const ok = Math.abs(nv - ne) <= tol;
  return result(check, ok ? "pass" : "fail", `json_path "${check.path}" = ${nv}, expect ${ne}±${tol}`);
}

function checkToolCount(check, parsed) {
  if (check.min === undefined && check.max === undefined) return result(check, "error", "tool_count requires min and/or max");
  for (const k of ["min", "max"]) {
    if (check[k] !== undefined && !Number.isInteger(check[k])) return result(check, "error", `tool_count ${k} must be an integer`);
  }
  let count;
  if (check.tool === undefined) {
    /* AMBIGUITY: tool omitted -> count ALL non-pending tool calls (biomcp and
     * non-biomcp alike); a biomcp-only total was not specified. */
    count = parsed.toolCalls.length;
  } else {
    const r = resolveToolRef(parsed, check.tool);
    if (r.error) return result(check, "error", r.error);
    count = r.missing ? 0 : r.calls.length;
  }
  const ok = (check.min === undefined || count >= check.min) && (check.max === undefined || count <= check.max);
  return result(check, ok ? "pass" : "fail",
    `count=${count} of ${check.tool === undefined ? "(any tool)" : JSON.stringify(check.tool)}; bounds [${check.min ?? "-inf"}, ${check.max ?? "inf"}]`);
}

function checkNoSuchTool(check, parsed) {
  const tools = Array.isArray(check.tool) ? check.tool : [check.tool];
  if (tools.length === 0 || tools.some((t) => typeof t !== "string" || t.length === 0)) {
    return result(check, "error", "no_such_tool requires a non-empty tool name or array of names");
  }
  const found = [...new Set(parsed.toolCalls.map((c) => c.tool))].filter((t) => tools.some((n) => t === n || t.endsWith(n)));
  return result(check, found.length === 0 ? "pass" : "fail",
    found.length === 0 ? `none of [${tools.join(", ")}] was called` : `forbidden tool(s) called: [${found.join(", ")}]`);
}

function checkStatus(check, parsed) {
  if (typeof check.status !== "string") return result(check, "error", "status requires string status");
  const g = getOccurrence(check, parsed);
  if (g.error) return result(check, "error", g.error);
  if (g.missing) return result(check, "fail", `no matching tool call: ${g.note ?? JSON.stringify(check.tool)}`);
  const ok = g.call.status === check.status;
  return result(check, ok ? "pass" : "fail", `${g.full}#${g.occ} status ${g.call.status}${ok ? " ==" : " !="} ${check.status}`);
}

function checkRubric(check) {
  if (check.manual !== true) return result(check, "error", "rubric requires manual: true");
  if (typeof check.flag !== "string" || !check.flag) return result(check, "error", "rubric requires string flag");
  return { ...result(check, "manual", `unadjudicated rubric flag: ${check.flag}`), flag: check.flag };
}

/* AMBIGUITY: the plan announces "13 check types" but enumerates 12 distinct
 * `type` values; group.anyOf / group.allOf are the two composition modes of a
 * single type. 12 types implemented. */
const CHECK_TYPES = {
  tool_seq: checkToolSeq,
  group: checkGroup,
  text: checkText,
  number_near: checkNumberNear,
  text_number_count: checkTextNumberCount,
  args: checkArgs,
  args_rel: checkArgsRel,
  json_path: checkJsonPath,
  tool_count: checkToolCount,
  no_such_tool: checkNoSuchTool,
  status: checkStatus,
  rubric: checkRubric,
};

function gradeRep(parsed, test) {
  const results = test.spec.checks.map((c) => evalCheck(c, parsed));
  const rubrics = results.filter((r) => r.status === "manual");
  let outcome;
  let reason = null;
  if (parsed.parsedCount === 0) {
    outcome = "ERROR";
    reason = "log has no parseable NDJSON events";
  } else if (!parsed.endsWithStop) {
    outcome = "ERROR";
    reason = "no terminal step_finish(reason=stop) at end of log";
  } else if (results.some((r) => r.status === "error")) {
    outcome = "ERROR";
    reason = `${results.filter((r) => r.status === "error").length} check(s) ERROR`;
  } else if (results.some((r) => r.status === "fail")) {
    outcome = "FAIL";
  } else {
    outcome = rubrics.length ? "PASS*" : "PASS";
  }
  const failing = results.filter((r) => r.status === "fail" || r.status === "error");
  return { outcome, reason, results, rubrics, failing };
}

/* ================================================================ SECTION: report */

function whichPath(tool) {
  try {
    const r = spawnSync("which", [tool], { encoding: "utf8", timeout: 15000 });
    const out = (r.stdout ?? "").trim();
    return r.status === 0 && out ? out.split(/\r?\n/)[0] : null;
  } catch {
    return null;
  }
}

function captureProvenance(args, dataRoot) {
  const prov = {
    gitCommit: null,
    opencodeVersion: null,
    model: args.model ?? null,
    dataRoot: path.resolve(dataRoot),
    timestamp: new Date().toISOString(),
    globalConfigSha256: null,
    hostBioTools: {},
  };
  try {
    const g = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 15000 });
    if (g.status === 0) prov.gitCommit = g.stdout.trim();
  } catch {}
  try {
    const v = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 30000 });
    if (v.status === 0) prov.opencodeVersion = (v.stdout ?? "").trim().split(/\r?\n/)[0];
  } catch {}
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const gcfg = homeDir ? path.join(homeDir, ".config", "opencode", "opencode.jsonc") : null;
  if (gcfg && fs.existsSync(gcfg)) {
    try {
      prov.globalConfigSha256 = crypto.createHash("sha256").update(fs.readFileSync(gcfg)).digest("hex");
    } catch {}
  }
  for (const t of ["samtools", "bcftools", "bedtools", "pysam"]) prov.hostBioTools[t] = whichPath(t);
  // Record the actual dist build provenance (git HEAD alone can't detect a
  // stale bundle that predates the checked-out commit).
  const bundle = path.join(REPO_ROOT, "dist", "bundle.js");
  if (fs.existsSync(bundle)) {
    try {
      const st = fs.statSync(bundle);
      prov.distBundleSha256 = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
      prov.distBundleMtime = st.mtime.toISOString();
    } catch {}
  }
  return prov;
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function printReportTable(rows) {
  const cols = [["TEST", 30], ["REP", 3], ["OUTCOME", 11], ["DETAIL", 80]];
  const head = cols.map(([h, w]) => h.padEnd(w)).join("  ");
  console.log("\n" + head);
  console.log("-".repeat(head.length));
  for (const r of rows) {
    console.log([
      truncate(r.test, 30).padEnd(30),
      String(r.rep).padEnd(3),
      String(r.outcome).padEnd(11),
      truncate(r.detail, 80),
    ].join("  "));
  }
}

function exitCodeFor(rows) {
  if (rows.some((r) => r.outcome === "ERROR" || r.outcome === "INTERRUPTED")) return 2;
  if (rows.some((r) => r.outcome === "FAIL")) return 1;
  return 0;
}

/* ======================================================================= SECTION: main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tests = discoverTests();
  if (args.list) {
    printListTable(tests);
    return 0;
  }
  const selected = selectTests(tests, args);

  const dataRoot = path.resolve(args.dataRoot ?? process.env.AGENT_TEST_DATA ?? path.join(RUNS_DIR, "data"));
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const provenance = captureProvenance(args, dataRoot);
  fs.writeFileSync(path.join(RUNS_DIR, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

  if (!fs.existsSync(path.join(REPO_ROOT, "dist", "bundle.js"))) {
    console.error(`warning: ${path.join(REPO_ROOT, "dist", "bundle.js")} does not exist; AGENT_TEST_BUNDLE will dangle`);
  }

  const rows = [];
  const testSummaries = [];
  let interrupted = false;

  for (const test of selected) {
    const entry = { id: test.id, dirName: test.dirName, reps: [], skipReason: null, errorReason: null };
    testSummaries.push(entry);
    if (test.error) {
      entry.errorReason = test.error;
      rows.push({ test: test.id, rep: "-", outcome: "ERROR", detail: test.error });
      continue;
    }
    if (interrupted) {
      entry.errorReason = "INTERRUPTED: APIError stop-loss in an earlier test";
      rows.push({ test: test.id, rep: "-", outcome: "INTERRUPTED", detail: entry.errorReason });
      continue;
    }
    const prov = await provisionTest(test, dataRoot);
    if (prov.status === "skip") {
      entry.skipReason = prov.reason;
      rows.push({ test: test.id, rep: "-", outcome: "SKIP", detail: prov.reason });
      continue;
    }
    if (prov.status === "error") {
      entry.errorReason = prov.reason;
      rows.push({ test: test.id, rep: "-", outcome: "ERROR", detail: prov.reason });
      continue;
    }
    if (args.dryRun) {
      rows.push({ test: test.id, rep: "-", outcome: "DRY", detail: `provisioned ok; ${test.spec.checks.length} check(s) parsed; prompt ${test.spec.prompt.length} chars` });
      continue;
    }
    for (let rep = 1; rep <= args.reps; rep++) {
      if (interrupted) {
        entry.reps.push({ rep, outcome: "INTERRUPTED", runDir: null, detail: "APIError stop-loss" });
        rows.push({ test: test.id, rep, outcome: "INTERRUPTED", detail: "APIError stop-loss" });
        continue;
      }
      let runDir;
      let logPath;
      let reused = false;
      const writeResult = (outcome, reason, extra = {}) => {
        const doc = {
          test: test.id,
          rep,
          runDir,
          reused,
          outcome,
          reason,
          rubricPending: false,
          rubricFlags: [],
          checks: [],
          gradedAt: new Date().toISOString(),
          ...extra,
        };
        fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(doc, null, 2) + "\n");
      };
      const resumeDir = args.force ? null : findResumeDir(test, rep);
      if (resumeDir) {
        runDir = resumeDir;
        logPath = path.join(runDir, "log.jsonl");
        reused = true;
      } else {
        const r = await runSession(test, rep, args, dataRoot);
        runDir = r.runDir;
        logPath = r.logPath;
        if (r.spawnError) {
          writeResult("ERROR", `spawn failed: ${r.spawnError.message}`);
          entry.reps.push({ rep, outcome: "ERROR", runDir, detail: `spawn failed: ${r.spawnError.message}` });
          rows.push({ test: test.id, rep, outcome: "ERROR", detail: `spawn failed: ${r.spawnError.message}` });
          continue;
        }
        if (r.timedOut) {
          const reason = `timeout after ${args.timeout ?? test.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms (SIGTERM -> ${TERM_GRACE_MS} ms -> SIGKILL)`;
          writeResult("ERROR", reason);
          entry.reps.push({ rep, outcome: "ERROR", runDir, detail: reason });
          rows.push({ test: test.id, rep, outcome: "ERROR", detail: "timeout (killed)" });
          continue;
        }
      }
      const parsed = readLogFile(logPath) ?? { events: [], parsedCount: 0, toolCalls: [], texts: [], endsWithStop: false, apiError: null };
      // Stop-loss only when the session never reached a terminal stop: a
      // transient APIError that opencode retried (session completed) grades
      // normally instead of halting the whole run.
      if (parsed.apiError && !parsed.endsWithStop) {
        const detail = `APIError stop-loss: ${JSON.stringify(parsed.apiError).slice(0, 200)}`;
        writeResult("INTERRUPTED", detail);
        entry.reps.push({ rep, outcome: "INTERRUPTED", runDir, detail });
        rows.push({ test: test.id, rep, outcome: "INTERRUPTED", detail });
        interrupted = true;
        continue;
      }
      const graded = gradeRep(parsed, test);
      writeResult(graded.outcome, graded.reason, {
        rubricPending: graded.rubrics.length > 0,
        rubricFlags: graded.rubrics.map((r2) => r2.flag),
        checks: graded.results,
      });
      const failDescs = graded.failing.map((f) => describeCheck(f)).join("; ");
      const detailParts = [];
      if (graded.reason) detailParts.push(graded.reason);
      if (failDescs) detailParts.push(failDescs);
      entry.reps.push({ rep, outcome: graded.outcome, runDir, detail: detailParts.join(" | "), reused });
      rows.push({ test: test.id, rep, outcome: graded.outcome, detail: truncate(detailParts.join(" | "), 200) });
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    args: { ...args, dataRoot },
    provenanceFile: path.join(RUNS_DIR, "provenance.json"),
    exitCode: exitCodeFor(rows),
    tests: testSummaries,
  };
  fs.writeFileSync(path.join(RUNS_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  printReportTable(rows);
  const counts = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  console.log(`\noutcomes: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
  const rubricRows = testSummaries.flatMap((t) => t.reps.filter((r) => r.outcome === "PASS*"));
  if (rubricRows.length) console.log(`unadjudicated rubric flags: ${rubricRows.length} rep(s) marked PASS* (see result.json)`);
  console.log(`summary: ${path.join(RUNS_DIR, "summary.json")}`);
  console.log(`provenance: ${path.join(RUNS_DIR, "provenance.json")}`);
  return exitCodeFor(rows);
}

process.exitCode = await (async () => {
  try {
    return await main();
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n\n${usage()}`);
      return 2;
    }
    console.error(`harness error: ${e?.stack ?? e}`);
    return 2;
  }
})();
