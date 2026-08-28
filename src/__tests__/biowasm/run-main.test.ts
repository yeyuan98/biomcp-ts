import { describe, it, expect } from '@jest/globals';
import { runMain, type RunMainModule } from '../../biowasm/run-main.js';

/**
 * Minimal mock of the biowasm module surface runMain touches: stackAlloc
 * hands out offsets into a fake stack image; HEAPU8/HEAP32 are views over
 * that image so argv assembly is observable byte-for-byte.
 */
function makeModule(impl: { main?: (argc: number, argv: number) => number; callMain?: (args: string[]) => number | undefined }) {
  const image = new ArrayBuffer(4096);
  let sp = 2048; // stack grows up in the mock
  const mod = {
    callMain: impl.callMain ?? (() => undefined),
    stackAlloc: (size: number) => {
      const ptr = sp;
      sp += size;
      return ptr;
    },
    HEAPU8: new Uint8Array(image),
    HEAP32: new Int32Array(image),
  };
  if (impl.main) (mod as { _main?: unknown })._main = impl.main;
  return mod as unknown as RunMainModule & { HEAPU8: Uint8Array; HEAP32: Int32Array };
}

describe('runMain (exit-status-recovering callMain replica)', () => {
  it('returns a plain _main return value', () => {
    expect(runMain(makeModule({ main: () => 0 }), 'samtools', ['--version'])).toBe(0);
    expect(runMain(makeModule({ main: () => 1 }), 'samtools', ['view'])).toBe(1);
  });

  it('recovers the status from a thrown ExitStatus (duck-typed {status})', () => {
    expect(runMain(makeModule({ main: () => { throw { status: 1 }; } }), 'samtools', ['view'])).toBe(1);
    expect(runMain(makeModule({ main: () => { throw { status: 2 }; } }), 'bcftools', ['view'])).toBe(2);
  });

  it('rethrows non-status exceptions', () => {
    const boom = new Error('budget breach');
    expect(() => runMain(makeModule({ main: () => { throw boom; } }), 'samtools', ['view'])).toThrow(boom);
  });

  it('falls back to callMain (null status) when _main is unavailable', () => {
    let calledWith: string[] | null = null;
    const mod = makeModule({ callMain: (args) => { calledWith = args; return undefined; } });
    (mod as { _main?: unknown })._main = undefined;
    expect(runMain(mod, 'samtools', ['view', '-c', 'x'])).toBeNull();
    expect(calledWith).toEqual(['view', '-c', 'x']);
  });

  it('assembles argv exactly like the glue: argv[0]=program, args, null terminator', () => {
    const mod = makeModule({
      main: (argc, argv) => {
        expect(argc).toBe(3);
        const readStr = (ptr: number) => {
          const bytes: number[] = [];
          while (mod.HEAPU8[ptr] !== 0) bytes.push(mod.HEAPU8[ptr++]);
          return String.fromCharCode(...bytes);
        };
        expect(readStr(mod.HEAP32[argv >> 2])).toBe('samtools');
        expect(readStr(mod.HEAP32[(argv >> 2) + 1])).toBe('view');
        expect(readStr(mod.HEAP32[(argv >> 2) + 2])).toBe('-c');
        expect(mod.HEAP32[(argv >> 2) + 3]).toBe(0);
        return 0;
      },
    });
    expect(runMain(mod, 'samtools', ['view', '-c'])).toBe(0);
  });

  it('writes UTF-8 bytes plus a NUL terminator for each string', () => {
    const mod = makeModule({
      main: (argc, argv) => {
        const argPtr = mod.HEAP32[(argv >> 2) + 1];
        const text = 'chr1:100-200';
        for (let i = 0; i < text.length; i++) expect(mod.HEAPU8[argPtr + i]).toBe(text.charCodeAt(i));
        expect(mod.HEAPU8[argPtr + text.length]).toBe(0);
        return 0;
      },
    });
    expect(runMain(mod, 'samtools', ['chr1:100-200'])).toBe(0);
  });
});
