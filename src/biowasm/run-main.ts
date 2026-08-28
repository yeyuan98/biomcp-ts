// runMain — exit-status-recovering replica of the pinned biowasm glue's
// callMain. The glue builds argv on the stack, calls Module._main(argc, argv),
// then `exit(ret, true)` and catches the resulting ExitStatus — swallowing the
// status on EVERY path (main return and C exit(n) alike). This replica
// rebuilds the argv exactly (TextEncoder + HEAPU8 stand in for the glue's
// internal allocateUTF8OnStack, which is not exported; stackAlloc/HEAPU8/
// HEAP32 are) but propagates the real status: a main return value or a
// duck-typed ExitStatus ({status: number}) becomes the return value, any other
// exception is rethrown. The argv stack is intentionally NOT restored — the
// original leaks it identically (~100 B/call, negligible).

export interface RunMainModule {
  _main?: (argc: number, argv: number) => number;
  callMain(args: string[]): number | undefined;
  stackAlloc(size: number): number;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

const utf8 = new TextEncoder();

function writeUtf8OnStack(Module: RunMainModule, text: string): number {
  const bytes = utf8.encode(text);
  const ptr = Module.stackAlloc(bytes.length + 1);
  Module.HEAPU8.set(bytes, ptr);
  Module.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

/**
 * Runs the module's C main and returns its real exit status, or null when
 * only the status-swallowing glue callMain is available (never coerced to 0).
 */
export function runMain(Module: RunMainModule, program: string, args: string[]): number | null {
  if (typeof Module._main !== 'function') {
    return Module.callMain(args) ?? null;
  }
  const argc = args.length + 1;
  const argv = Module.stackAlloc((argc + 1) * 4);
  Module.HEAP32[argv >> 2] = writeUtf8OnStack(Module, program);
  for (let i = 1; i < argc; i++) {
    Module.HEAP32[(argv >> 2) + i] = writeUtf8OnStack(Module, args[i - 1]);
  }
  Module.HEAP32[(argv >> 2) + argc] = 0;
  try {
    return Module._main(argc, argv);
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number') return status;
    throw err;
  }
}
