import { createRequire } from 'node:module'

import test from 'ava'

import { chunkBySize, chunkByByte, driveClassCompress, loadCompressor, oneShot, type Namespace } from './helpers'

// Bare `require` is undefined under the ESM test loader (@oxc-node); bind one to
// this file to optionally resolve the native `lzma-native` oracle.
const requireFrom = createRequire(import.meta.url)

const IS_WASI = !!process.env.NAPI_RS_FORCE_WASI

const INPUT = Buffer.from('Hello 🚀'.repeat(500), 'utf8')

const NAMESPACES: readonly Namespace[] = ['lzma', 'lzma2', 'xz']

/**
 * Interleave empty chunks with 1-byte chunks: a deliberately awkward chunking
 * that stresses empty-`update()` no-ops AND fine-grained boundaries at once.
 */
const emptyAnd1Byte = (buf: Buffer): Uint8Array[] => {
  const chunks: Uint8Array[] = [Buffer.alloc(0)]
  for (const byte of chunkByByte(buf)) {
    chunks.push(byte)
    chunks.push(Buffer.alloc(0))
  }
  return chunks
}

const CHUNKINGS: ReadonlyArray<{ name: string; split: (buf: Buffer) => Uint8Array[] }> = [
  { name: '1-byte', split: (buf) => chunkByByte(buf) },
  { name: '64-byte', split: (buf) => chunkBySize(buf, 64) },
  { name: 'single-chunk', split: (buf) => [buf] },
  { name: 'awkward empty+1-byte', split: (buf) => emptyAnd1Byte(buf) },
]

// ── Round-trip through the T0 one-shot decoder (the oracle) ──────────────────

for (const ns of NAMESPACES) {
  for (const { name, split } of CHUNKINGS) {
    test(`${ns}: class compress round-trips via one-shot decode (${name})`, async (t) => {
      const compressed = await driveClassCompress(ns, split(INPUT))
      const restored = await oneShot(ns).decompress(compressed)
      t.deepEqual(Buffer.from(restored), INPUT)
    })
  }
}

// ── Byte-identity invariant: proves `update()` never flushes ─────────────────
// The full compressed stream must be byte-identical no matter how the input is
// chunked. Any per-chunk flush/`set_flushing()` would force a chunk boundary and
// change the bytes (most visibly for LZMA2), so this is the key correctness signal.

for (const ns of NAMESPACES) {
  test(`${ns}: class compress output is byte-identical across all chunkings`, async (t) => {
    const reference = await driveClassCompress(ns, [INPUT])
    for (const { name, split } of CHUNKINGS) {
      const got = await driveClassCompress(ns, split(INPUT))
      t.true(got.equals(reference), `${ns} ${name} output diverged from the single-chunk reference`)
    }
  })
}

// ── Empty input: zero update() calls then finish() ───────────────────────────

for (const ns of NAMESPACES) {
  test(`${ns}: class compress of empty input decodes back to empty`, async (t) => {
    const compressed = await driveClassCompress(ns, [])
    const restored = await oneShot(ns).decompress(compressed)
    t.is(restored.length, 0)
  })
}

// ── Constructor input validation (Fix 1) ─────────────────────────────────────
// Out-of-range `preset` / `dictSize` must throw a clean napi `InvalidArg` error
// at construction time — never panic, OOM, or abort the process. A JS caller
// passing e.g. `{ dictSize: 0 }` (underflow) or a huge value (multi-GiB alloc)
// used to crash the whole process instead of getting a catchable error.

const isInvalidArg = (err: unknown): boolean => err instanceof Error && (err as { code?: string }).code === 'InvalidArg'

for (const ns of NAMESPACES) {
  test(`${ns}: out-of-range preset throws InvalidArg (does not crash)`, (t) => {
    const Compressor = loadCompressor(ns)
    const err = t.throws(() => new Compressor({ preset: 42 }))
    t.true(isInvalidArg(err), `expected an InvalidArg napi error, got ${String(err)}`)
  })

  test(`${ns}: valid presets (1 and 9) construct and round-trip`, async (t) => {
    for (const preset of [1, 9]) {
      const compressed = await driveClassCompress(ns, chunkBySize(INPUT, 64), { preset })
      const restored = await oneShot(ns).decompress(compressed)
      t.deepEqual(Buffer.from(restored), INPUT, `preset ${preset} must construct and round-trip`)
    }
  })
}

test('lzma2: dictSize 0 (< DICT_SIZE_MIN) throws InvalidArg, does not crash', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  const err = t.throws(() => new Lzma2Compressor({ dictSize: 0 }))
  t.true(isInvalidArg(err), `expected an InvalidArg napi error, got ${String(err)}`)
})

test('lzma2: oversized dictSize (> DICT_SIZE_MAX) throws InvalidArg, does not OOM/abort', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  const err = t.throws(() => new Lzma2Compressor({ dictSize: 0xffffffff }))
  t.true(isInvalidArg(err), `expected an InvalidArg napi error, got ${String(err)}`)
})

test('lzma2: valid 8 MiB dictSize constructs and round-trips via one-shot decode', async (t) => {
  // The one-shot lzma2 decoder is pinned to 8 MiB, so use 8 MiB to keep the
  // round-trip decodable while still exercising the explicit-dictSize path.
  const compressed = await driveClassCompress('lzma2', chunkBySize(INPUT, 64), { dictSize: 8 << 20 })
  const restored = await oneShot('lzma2').decompress(compressed)
  t.deepEqual(Buffer.from(restored), INPUT)
})

// ── Strict C-decode: validates the trailer/footer/end-marker is well-formed ──
// When not WASI and `lzma-native` is present, decode our class output with the C
// implementation for xz and lzma. Degrade gracefully (skip) otherwise.

type NativeDecode = (buf: Buffer) => Promise<Buffer>

const nativeStrictDecode: Partial<Record<Namespace, NativeDecode>> = {}

// Only WASI legitimately lacks `lzma-native` (mirrors the per-namespace specs'
// `NAPI_RS_FORCE_WASI` gate). On a normal platform a load failure is a REAL
// regression of the trailer/footer gate, so we record it and FAIL below rather
// than swallowing it into a `t.pass()`.
let nativeLoadError: unknown
if (!IS_WASI) {
  try {
    const lzmaNative = requireFrom('lzma-native')
    nativeStrictDecode.xz = (buf) =>
      new Promise((resolve, reject) => {
        lzmaNative.decompress(buf, (result: Buffer | null) => {
          if (result) {
            resolve(Buffer.from(result))
          } else {
            reject(new Error('lzma-native failed to decode xz output'))
          }
        })
      })
    nativeStrictDecode.lzma = (buf) => {
      const engine = lzmaNative.LZMA()
      return new Promise((resolve, reject) => {
        engine.decompress(buf, (result: Buffer | null) => {
          if (result) {
            resolve(Buffer.from(result))
          } else {
            reject(new Error('lzma-native failed to decode lzma output'))
          }
        })
      })
    }
  } catch (err) {
    // Remember WHY `lzma-native` did not load so the strict-decode legs can fail
    // loudly on a platform that should have provided it (non-WASI).
    nativeLoadError = err
  }
}

for (const ns of ['xz', 'lzma'] as const) {
  test(`${ns}: class output is strictly decodable by lzma-native`, async (t) => {
    const decode = nativeStrictDecode[ns]
    if (!decode) {
      if (IS_WASI) {
        t.pass('lzma-native unavailable under WASI; skipping strict C-decode')
        return
      }
      // Non-WASI: `lzma-native` MUST be usable, so a missing decoder is a real
      // failure of the trailer/footer regression gate, not a skip.
      t.fail(`lzma-native must load on a non-WASI platform (strict C-decode gate); load failed: ${String(nativeLoadError)}`)
      return
    }
    const compressed = await driveClassCompress(ns, chunkBySize(INPUT, 64))
    const restored = await decode(compressed)
    t.deepEqual(Buffer.from(restored), INPUT)
  })
}
