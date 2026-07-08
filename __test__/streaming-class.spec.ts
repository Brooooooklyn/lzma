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

// Encoder-safe dictionary cap (mirrors `MAX_DICT_SIZE` in `src/backend.rs`).
// `lzma_rust2`'s exported `DICT_SIZE_MAX` (0xfffffff0) is a decode-only bound:
// feeding it to the encoder reaches `Bt4::new`, where `dict_size as i32 + 1`
// overflows and a `~dict*8` byte allocation OOM/aborts the process. Validation
// must reject anything above this cap BEFORE any writer is allocated.
const MAX_DICT_SIZE = 256 << 20

test('lzma2: dictSize 0 (< DICT_SIZE_MIN) throws InvalidArg, does not crash', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  const err = t.throws(() => new Lzma2Compressor({ dictSize: 0 }))
  t.true(isInvalidArg(err), `expected an InvalidArg napi error, got ${String(err)}`)
})

test('lzma2: below-min dictSize (4095 < DICT_SIZE_MIN) throws InvalidArg', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  const err = t.throws(() => new Lzma2Compressor({ dictSize: 4095 }))
  t.true(isInvalidArg(err), `expected an InvalidArg napi error, got ${String(err)}`)
})

// The critical case: 0xfffffff0 == lzma_rust2's DICT_SIZE_MAX. The OLD validator
// accepted it (it was in `DICT_SIZE_MIN..=DICT_SIZE_MAX`), so constructing a
// compressor with it reached `Bt4::new` and ABORTED the whole process. It must
// now be a clean, in-process, catchable throw — validation rejects it BEFORE any
// allocation, so this `t.throws` can never take the test runner down.
test('lzma2: dangerous dictSize 0xfffffff0 throws InvalidArg, does NOT abort the process', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  const err = t.throws(() => new Lzma2Compressor({ dictSize: 0xfffffff0 }))
  t.true(isInvalidArg(err), `expected an InvalidArg napi error, got ${String(err)}`)
})

test('lzma2: dictSize just above the encoder cap (MAX_DICT_SIZE + 1) throws InvalidArg', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  const err = t.throws(() => new Lzma2Compressor({ dictSize: MAX_DICT_SIZE + 1 }))
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
// When `lzma-native` loads, decode our class output with the independent C
// implementation for xz and lzma — real coverage of the format trailer /
// end-marker. `lzma-native` is a prebuilt C addon that legitimately CANNOT load
// on some targets: under WASI, and on arches with no prebuild (the qemu-docker
// s390x / ppc64le / riscv64 / armv7 / aarch64-musl CI legs, where the addon does
// not ship). On any such load failure the strict leg is registered as a real ava
// SKIP — never a silent `t.pass()` (which would masquerade as C-decode coverage)
// and never a hard failure (which would redden those legitimate CI targets).

type NativeDecode = (buf: Buffer) => Promise<Buffer>

const nativeStrictDecode: Partial<Record<Namespace, NativeDecode>> = {}

// Try to load `lzma-native`; on ANY failure (WASI or a prebuild-less arch) leave
// `lzmaNativeAvailable` false so the strict legs register as skipped below.
let lzmaNativeAvailable = false
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
    lzmaNativeAvailable = true
  } catch {
    // `lzma-native` is unavailable on this platform (WASI or an arch with no
    // prebuild); the strict legs register as an honest ava SKIP below.
  }
}

// Conditional registration: run the strict assertions only when `lzma-native`
// loaded; otherwise register a genuine ava SKIP so the runner reports the leg as
// skipped (honest) rather than passed (masquerade) or failed (breaks CI targets).
const strictTest = lzmaNativeAvailable ? test : test.skip

for (const ns of ['xz', 'lzma'] as const) {
  strictTest(`${ns}: class output is strictly decodable by lzma-native`, async (t) => {
    const decode = nativeStrictDecode[ns]!
    const compressed = await driveClassCompress(ns, chunkBySize(INPUT, 64))
    const restored = await decode(compressed)
    t.deepEqual(Buffer.from(restored), INPUT)
  })
}
