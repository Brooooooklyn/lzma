import { createRequire } from 'node:module'

import test from 'ava'

import {
  awkwardChunks,
  chunkBySize,
  chunkByByte,
  driveClassCompress,
  driveClassDecompress,
  loadCompressor,
  loadDecompressor,
  lowEntropyBytes,
  oneShot,
  IS_32BIT,
  IS_SLOW_EMULATED_ARCH,
  SUPPORTS_STREAMING_WASI,
  type CompressorInstance,
  type DecompressorInstance,
  type Namespace,
} from './helpers'

// Bare `require` is undefined under the ESM test loader (@oxc-node); bind one to
// this file to optionally resolve the native `lzma-native` oracle.
const requireFrom = createRequire(import.meta.url)

const IS_WASI = !!process.env.NAPI_RS_FORCE_WASI

// The COMPRESSOR classes build tokio-free and run fine under emnapi/WASI (they
// use an `AsyncTask`, not a persistent worker thread). The pull-based
// DECOMPRESSOR, however, spawns one OS/worker thread AND allocates its LZMA
// dictionary in shared wasm linear memory per live instance; many concurrent
// decoders exhaust that memory under emnapi — observed as nondeterministic
// "Out of memory" thrown from `update()` (T7). So the decode cases self-skip
// under WASI unless `SUPPORTS_STREAMING_WASI` flips true; native / musl / qemu
// still cover them. This is an honest coordination skip, NOT a silent pass.
const classTest = IS_WASI && !SUPPORTS_STREAMING_WASI ? test.skip : test

// The 5 MB canary and the 8 MiB decompression bomb below each drive > 4 MiB
// through the class worker. On the QEMU-emulated s390x/ppc64le legs `classTest`
// is NOT skipped (those legs are NOT WASI — `classTest == test` there), so without
// this extra gate they run under emulation, exceed ava's timeout, and are swallowed
// by `continue-on-error`, voiding the intended big-endian coverage. `bigClassTest`
// is an HONEST ava skip on the emulated legs (inheriting the WASI class-skip via the
// same expression); native keeps full > 4 MiB coverage. See IS_SLOW_EMULATED_ARCH.
const bigClassTest = (IS_WASI && !SUPPORTS_STREAMING_WASI) || IS_SLOW_EMULATED_ARCH ? test.skip : test
const EMULATED_SKIP_NOTE = IS_SLOW_EMULATED_ARCH ? ' [>4MB: skipped on emulated s390x/ppc64le]' : ''

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

// ── String chunks: update() accepts `string`, UTF-8 encoded (T5) ─────────────
// The class compressor's `update()` takes `string | Uint8Array` to match the
// one-shot `compress` convention. A string chunk must be UTF-8 encoded, so (1) it
// round-trips back to the string's UTF-8 bytes, and (2) its compressed stream is
// BYTE-IDENTICAL to feeding the equivalent Buffer — proving the string path is a
// pure UTF-8 encode, not a re-interpretation. `INPUT` already contains a 4-byte
// emoji, so multi-byte encoding is exercised.

const STRING_CHUNK = 'Hello 🚀 streaming string chunk — Ünïcöde'

for (const ns of NAMESPACES) {
  test(`${ns}: class compress accepts a string chunk (UTF-8) and round-trips`, async (t) => {
    const Compressor = loadCompressor<CompressorInstance>(ns)
    const compressor = new Compressor()
    const head = Buffer.from(compressor.update(STRING_CHUNK))
    const tail = Buffer.from(await compressor.finish())
    const restored = await oneShot(ns).decompress(Buffer.concat([head, tail]))
    t.deepEqual(Buffer.from(restored), Buffer.from(STRING_CHUNK, 'utf8'))
  })

  test(`${ns}: a string chunk compresses byte-identically to the equivalent Uint8Array`, async (t) => {
    const fromString = await driveClassCompress(ns, [STRING_CHUNK])
    const fromBytes = await driveClassCompress(ns, [Buffer.from(STRING_CHUNK, 'utf8')])
    t.true(fromString.equals(fromBytes), `${ns}: string-chunk output diverged from the Uint8Array output`)
  })
}

// ── Constructor input validation (Fix 1) ─────────────────────────────────────
// Out-of-range `preset` / `dictSize` must throw a clean napi `InvalidArg` error
// at construction time — never panic, OOM, or abort the process. A JS caller
// passing e.g. `{ dictSize: 0 }` (underflow) or a huge value (multi-GiB alloc)
// used to crash the whole process instead of getting a catchable error.

const isInvalidArg = (err: unknown): boolean => err instanceof Error && (err as { code?: string }).code === 'InvalidArg'

for (const ns of NAMESPACES) {
  test(`${ns}: out-of-range / non-integer preset throws InvalidArg (no ToUint32 bypass)`, (t) => {
    const Compressor = loadCompressor(ns)
    // 10 / 42: above the 0..=9 range (the crate would otherwise silently clamp
    // to 9). 9.9 / NaN / Infinity / -1 / 2^32+9: values that napi's implicit
    // `ToUint32` coercion would silently wrap/truncate into an in-range u32
    // (9.9->9, NaN->0, Infinity->0, -1->wraps, 4294967305->9) if `preset` were a
    // `u32` field. Because it is declared `f64`, the raw JS number reaches Rust
    // and is rejected as non-integer / out-of-range. Pure validation — it throws
    // before any encoder/dictionary is allocated, so it is cheap on every arch.
    for (const preset of [10, 42, 9.9, NaN, Infinity, -1, 4294967305]) {
      const err = t.throws(() => new Compressor({ preset }))
      t.true(isInvalidArg(err), `expected an InvalidArg napi error for preset ${preset}, got ${String(err)}`)
    }
  })

  // Use CHEAP in-range presets only. Preset bound-checking does not require
  // constructing at preset 9 — for lzma/xz a preset-9 dict is 64 MiB (~750 MB
  // encoder alloc) that could OOM constrained 32-bit CI legs. Presets 0/1/6 map
  // to 256 KiB / 1 MiB / 8 MiB dicts, so this proves in-range presets construct
  // and round-trip without any heavy high-preset allocation. (lzma2 pins its
  // dict to 8 MiB regardless of preset, so it would be cheap either way.)
  test(`${ns}: valid presets (0, 1, 6) construct and round-trip`, async (t) => {
    for (const preset of [0, 1, 6]) {
      const compressed = await driveClassCompress(ns, chunkBySize(INPUT, 64), { preset })
      const restored = await oneShot(ns).decompress(compressed)
      t.deepEqual(Buffer.from(restored), INPUT, `preset ${preset} must construct and round-trip`)
    }
  })
}

// Valid integer presets 0 and 9 must still construct after the f64-field change.
// Only lzma2 is exercised at preset 9 because it pins its dictionary to 8 MiB
// regardless of preset (A10), so the construct is memory-cheap and decodable by
// the 8-MiB-pinned one-shot oracle — unlike lzma/xz, whose preset-9 dict is
// 64 MiB (~750 MB alloc) and would be risky on constrained 32-bit CI legs.
test('lzma2: valid integer presets 0 and 9 construct and round-trip (dict pinned 8 MiB)', async (t) => {
  for (const preset of [0, 9]) {
    const compressed = await driveClassCompress('lzma2', chunkBySize(INPUT, 64), { preset })
    const restored = await oneShot('lzma2').decompress(compressed)
    t.deepEqual(Buffer.from(restored), INPUT, `preset ${preset} must construct and round-trip`)
  }
})

// Encoder dictionary cap (mirrors `MAX_DICT_SIZE` in `src/backend.rs`).
// The cap equals preset 9's dictionary (64 MiB): `dictSize` must not let a
// caller request more memory than preset selection already permits, so any
// value above it is rejected. `lzma_rust2`'s exported `DICT_SIZE_MAX`
// (0xfffffff0) is a decode-only bound: feeding it to the encoder reaches
// `Bt4::new`, where `dict_size as i32 + 1` overflows and a `~dict*8` byte
// allocation OOM/aborts the process. Validation must reject anything above this
// cap BEFORE any writer is allocated.
const MAX_DICT_SIZE = 64 << 20

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

// The ToUint32-bypass cases: had `dictSize` stayed a `u32` field, each of these
// JS numbers would be silently coerced into a DIFFERENT, in-range dictionary
// (4194304.5->4194304, NaN->0, Infinity->0, -1->0xffffffff, 4294971392 (2^32+4096)
// ->4096, -4294963200->4096) and accepted, so the caller would get a dictionary
// they never requested. Because `dictSize` is `f64`, the raw number reaches Rust
// and is rejected as non-integer / out-of-range BEFORE any writer is allocated.
test('lzma2: non-integer / ToUint32-bypass dictSize throws InvalidArg', (t) => {
  const Lzma2Compressor = loadCompressor('lzma2')
  for (const dictSize of [4194304.5, NaN, Infinity, -1, 4294971392, -4294963200]) {
    const err = t.throws(() => new Lzma2Compressor({ dictSize }))
    t.true(isInvalidArg(err), `expected an InvalidArg napi error for dictSize ${dictSize}, got ${String(err)}`)
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING DECOMPRESSOR (T3) — oracle = the T0 one-shot COMPRESS.
// The pull-based decoders run on a worker thread fed by a bounded channel; the
// deadlock canaries below (5 MB + decompression bomb) would HANG a naive driver.
// ═══════════════════════════════════════════════════════════════════════════

// ── 1) One-shot-compressed → class decode, tiny chunks (per format) ──────────
// Compress with the trusted one-shot (oracle), split the compressed bytes into
// deliberately tiny chunks, and decode incrementally through the class. Proves
// the worker reassembles a stream fragmented at arbitrary byte boundaries.

for (const ns of NAMESPACES) {
  classTest(`${ns}: class decompress of one-shot output round-trips (3-byte chunks)`, async (t) => {
    const compressed = await oneShot(ns).compress(INPUT)
    const restored = await driveClassDecompress(ns, chunkBySize(compressed, 3))
    t.deepEqual(restored, INPUT)
  })
}

// ── 2) Empty-input stream decodes back to empty (per format) ─────────────────
// The compressed form of empty input is NON-empty (header + end marker, or the
// canonical empty `.xz`); the worker must consume it and emit zero bytes.

for (const ns of NAMESPACES) {
  classTest(`${ns}: class decompress of an empty-input stream yields empty`, async (t) => {
    const compressed = await oneShot(ns).compress(Buffer.alloc(0))
    const restored = await driveClassDecompress(ns, chunkByByte(compressed))
    t.is(restored.length, 0)
  })
}

// ── 3) 5 MB incremental fixture (deadlock canary) ────────────────────────────
// A 5 MB payload compressed then decoded via the class in tiny chunks. The
// worker emits 64 KiB output messages incrementally while JS keeps feeding, so
// the bounded channels fill and drain repeatedly. A driver deadlock (worker
// parked on a full out channel while `update` parks on a full in channel) would
// HANG this test until ava's 2 min timeout.

const FIVE_MB = lowEntropyBytes(5 * 1024 * 1024)

for (const ns of NAMESPACES) {
  bigClassTest(`${ns}: class decompress of a 5 MB stream round-trips incrementally${EMULATED_SKIP_NOTE}`, async (t) => {
    const compressed = await oneShot(ns).compress(FIVE_MB)
    const restored = await driveClassDecompress(ns, chunkBySize(compressed, 5))
    t.true(restored.equals(FIVE_MB), `${ns} 5 MB round-trip mismatch`)
  })
}

// ── 4) Full class round-trip: driveClassCompress → driveClassDecompress ───────
// End-to-end through BOTH streaming classes across several chunkings, with the
// compress and decompress halves chunked INDEPENDENTLY (the compressed stream is
// re-split for the decoder), so no boundary alignment is assumed anywhere.

const ROUND_TRIP_CHUNKINGS: ReadonlyArray<{ name: string; split: (buf: Buffer) => Uint8Array[] }> = [
  { name: '1-byte', split: (buf) => chunkByByte(buf) },
  { name: '64-byte', split: (buf) => chunkBySize(buf, 64) },
  { name: 'single-chunk', split: (buf) => [buf] },
  { name: 'awkward', split: (buf) => awkwardChunks(buf) },
]

for (const ns of NAMESPACES) {
  for (const { name, split } of ROUND_TRIP_CHUNKINGS) {
    classTest(`${ns}: class compress → class decompress round-trips (${name})`, async (t) => {
      const compressed = await driveClassCompress(ns, split(INPUT))
      const restored = await driveClassDecompress(ns, split(compressed))
      t.deepEqual(restored, INPUT)
    })
  }
}

// ── 5) lzma2 explicit dictSize round-trip (must match the pinned 8 MiB) ───────
// Encode + decode both pinned to 8 MiB (`LZMA2_DICT_SIZE`); the raw LZMA2 stream
// carries no in-band dictionary size, so both sides must agree out of band.

classTest('lzma2: class decompress with explicit dictSize (8 MiB) round-trips', async (t) => {
  const compressed = await driveClassCompress('lzma2', chunkBySize(INPUT, 64), { dictSize: 8 << 20 })
  const restored = await driveClassDecompress('lzma2', chunkBySize(compressed, 3), { dictSize: 8 << 20 })
  t.deepEqual(restored, INPUT)
})

// ── 6) lzma2 decompressor dictSize validation (reuse the T2 rejection set) ────
// The SAME validation infra the encoder uses guards the decoder's `dictSize`:
// out-of-range / non-integer / ToUint32-bypass values must throw a clean napi
// `InvalidArg` at CONSTRUCTION — never panic, OOM, or abort the process. A bad
// value must reject before any worker/reader is built. (`MAX_DICT_SIZE` is
// declared once above, shared with the compressor half.)

test('lzma2: decompressor rejects invalid dictSize with InvalidArg (no crash)', (t) => {
  const Lzma2Decompressor = loadDecompressor('lzma2')
  // 0: below DICT_SIZE_MIN. (64<<20)+1: above the encoder-safe cap. NaN /
  // 4194304.5: non-finite / fractional. 4294967296 (2^32): would wrap to 0 under
  // ToUint32. 0xfffffff0: lzma_rust2's decode-only DICT_SIZE_MAX (unsafe here).
  for (const dictSize of [0, MAX_DICT_SIZE + 1, NaN, Infinity, 4194304.5, 4294967296, 0xfffffff0]) {
    const err = t.throws(() => new Lzma2Decompressor({ dictSize }))
    t.true(isInvalidArg(err), `expected an InvalidArg napi error for dictSize ${dictSize}, got ${String(err)}`)
  }
})

classTest('lzma2: decompressor with absent options uses the pinned 8 MiB default', async (t) => {
  // No options → default 8 MiB, which matches the encoder's pinned default, so a
  // stream compressed at the default dictionary decodes without an explicit size.
  const compressed = await oneShot('lzma2').compress(INPUT)
  const restored = await driveClassDecompress('lzma2', chunkBySize(compressed, 3))
  t.deepEqual(restored, INPUT)
})

// ── 7) Decompression-bomb / backpressure (the deadlock canary) ───────────────
// A highly compressible 8 MiB-of-zeros payload compresses to a few hundred
// bytes. Fed to the decoder in tiny chunks, the worker wants to produce all
// 8 MiB at once, but the bounded out channel forces it to block on `out_tx.send`
// after ~512 KiB in flight — so `update` MUST keep draining to make progress.
// A naive driver deadlocks here; a correct one round-trips to 8 MiB of zeros
// within ava's timeout and with bounded (not 8 MiB × N) memory.

const EIGHT_MIB_ZEROS = Buffer.alloc(8 << 20)

for (const ns of NAMESPACES) {
  bigClassTest(
    `${ns}: decompression bomb (8 MiB zeros, tiny chunks) round-trips without hanging${EMULATED_SKIP_NOTE}`,
    async (t) => {
      const compressed = await oneShot(ns).compress(EIGHT_MIB_ZEROS)
      t.true(compressed.length < EIGHT_MIB_ZEROS.length / 100, `${ns} bomb payload should be tiny`)
      const restored = await driveClassDecompress(ns, chunkBySize(compressed, 4))
      t.is(restored.length, EIGHT_MIB_ZEROS.length)
      t.true(restored.equals(EIGHT_MIB_ZEROS), `${ns} bomb round-trip mismatch`)
    },
  )
}

// ── 8) Truncated input → finish() rejects, process stays alive (smoke) ────────
// T6 owns the full garbage/truncated assertions; here we only prove the plumbing
// does not HANG or crash. Feed the first half of a valid stream (mid-stream
// truncation) and assert the driver rejects, then prove the process is alive by
// decoding a fresh valid stream on a NEW instance right after.

for (const ns of NAMESPACES) {
  classTest(`${ns}: truncated stream rejects and leaves the process alive`, async (t) => {
    const compressed = await oneShot(ns).compress(INPUT)
    const truncated = compressed.subarray(0, Math.floor(compressed.length / 2))
    await t.throwsAsync(() => driveClassDecompress(ns, chunkBySize(truncated, 7)))
    // The runner is still alive: a brand-new instance decodes a valid stream.
    const restored = await driveClassDecompress(ns, chunkBySize(compressed, 7))
    t.deepEqual(restored, INPUT)
  })
}

// ── 9) Lifecycle guards: double-finish and use-after-finish reject cleanly ────

for (const ns of NAMESPACES) {
  classTest(`${ns}: second finish() and update()-after-finish() reject (no panic)`, async (t) => {
    const compressed = await oneShot(ns).compress(INPUT)
    const Decompressor = loadDecompressor<DecompressorInstance>(ns)
    const d = new Decompressor()
    // The valid output is `update()` output + `finish()` tail (some formats emit
    // the bulk during `update()`, others hold it until the EOF at `finish()`).
    const mid = Buffer.from(d.update(compressed))
    const tail = await d.finish()
    t.true(Buffer.concat([mid, tail]).equals(INPUT), 'first finish() returns the full output')
    // `finish()`/`update()` return a napi `Result`, so the post-finish guard is a
    // SYNCHRONOUS throw at the call site (not a rejected promise).
    t.throws(() => d.finish(), undefined, 'second finish() must throw')
    t.throws(() => d.update(Buffer.alloc(1)), undefined, 'update() after finish() must throw')
  })
}

// ── 10) Sticky decode errors: update()-surfaced failure must taint finish() ───
// THE REGRESSION (T3 review). A worker decode error surfaced FIRST by `update()`
// used to be consumed once and dropped: a later `finish()` drained an already
// empty channel from the exited worker and FALSELY resolved with a Buffer — a
// success after the stream had already failed. The fix records the terminal
// error as sticky, so `update()` AND `finish()` both keep rejecting once the
// decoder has failed.

// Clearly-invalid compressed bytes chosen so EACH format's decoder errors FAST
// (before EOF), so `update()` — not just `finish()` — is the first to observe
// it. Values are from lzma_rust2 0.15.8's eager validation:
//   lzma : props byte 0xff > 224            → "invalid props byte" at header read
//   lzma2: reserved control byte 0x20 on the first (dict-reset) chunk → "LZMA2:0"
//          (0xff is a VALID LZMA2 LZMA-chunk control, so it would NOT fail fast)
//   xz   : bytes with no XZ magic           → invalid stream header on first read
const FAST_FAIL_GARBAGE: Record<Namespace, Buffer> = {
  lzma: Buffer.alloc(64, 0xff),
  lzma2: Buffer.alloc(64, 0x20),
  xz: Buffer.alloc(64, 0xff),
}

/**
 * Feed garbage, then poll `update()` (yielding to let the worker OS thread push
 * its decode error onto the bounded out channel) until an `update()` call
 * surfaces the error synchronously. Returns the thrown error. Bounded retries so
 * a slow CI worker still gets a chance before we assert; throws if it never does.
 */
const updateUntilRejects = async (d: DecompressorInstance, garbage: Buffer): Promise<unknown> => {
  const chunks: Buffer[] = [garbage, ...Array.from({ length: 200 }, () => Buffer.alloc(0))]
  for (const chunk of chunks) {
    try {
      d.update(chunk)
    } catch (err) {
      return err // update() drained + surfaced the sticky decode error
    }
    // Give the worker thread a real timer tick to decode and push its error.
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('update() never surfaced the worker decode error')
}

for (const ns of NAMESPACES) {
  classTest(`${ns}: decode error is sticky — update() rejects, then finish() ALSO rejects`, async (t) => {
    const Decompressor = loadDecompressor<DecompressorInstance>(ns)
    const d = new Decompressor()
    // 1) update() (the first driving call to reach the decoder) surfaces the
    //    worker's decode error as a synchronous InvalidArg throw.
    const err = await updateUntilRejects(d, FAST_FAIL_GARBAGE[ns])
    t.true(isInvalidArg(err), `expected InvalidArg from update(), got ${String(err)}`)
    // 2) A SUBSEQUENT update() also throws (fail-fast) — it must not silently
    //    succeed by pushing more input to the dead worker.
    t.throws(() => d.update(Buffer.alloc(1)), undefined, 'update() after a sticky failure must throw')
    // 3) THE BUG: finish() after an update()-surfaced decode error MUST reject —
    //    it must NOT resolve with a (empty) Buffer.
    await t.throwsAsync(
      () => d.finish(),
      undefined,
      'finish() must reject after an update()-surfaced decode error, not resolve with a Buffer',
    )
  })
}

// ── 11) finish() as the FIRST observer of the error (truncated, no draining) ──
// The mirror case: feed a truncated-but-well-formed prefix (valid header, body
// cut) so `update()` does NOT error (the worker blocks awaiting more input), then
// `finish()` drops `in_tx` → the worker hits EOF mid-decode → error. finish()
// must reject. (This path likely already held; kept as a sticky-error guard.)

for (const ns of NAMESPACES) {
  classTest(`${ns}: finish() rejects when it is the first to observe the decode error (truncated)`, async (t) => {
    const compressed = await oneShot(ns).compress(INPUT)
    const truncated = compressed.subarray(0, Math.max(1, Math.floor(compressed.length / 2)))
    const Decompressor = loadDecompressor<DecompressorInstance>(ns)
    const d = new Decompressor()
    // Header parses; the worker consumes the prefix and parks awaiting more, so
    // this update() returns (partial/empty) without an error.
    d.update(truncated)
    await t.throwsAsync(() => d.finish(), undefined, 'finish() must reject on a truncated stream')
  })
}

// ── 12) Concurrency probe: many simultaneous Decompressors (async pool) ───────
// The decisive wasm-parity probe (T7). Each `Decompressor` spawns one worker
// thread PULLING from a bounded channel + PUSHING decoded 64 KiB messages back,
// and holds its LZMA dictionary live for the instance's lifetime. This test
// constructs `N` decompressors ACROSS all three formats and drives them ALL AT
// ONCE (every `new Decompressor()` + its `update()` feed happens synchronously
// inside the `.map`, so at the `Promise.all` await every worker is live), then
// asserts every one round-trips. It confirms the native async-work-pool / worker
// threads are NOT starved when many decoders run concurrently.
//
// Under emnapi/WASI those `N` worker threads + `N` dictionaries share one wasm
// linear-memory arena, which the concurrent load exhausts ("Out of memory" from
// `napi_get_typedarray_info` in `update()`), so this self-skips there via
// `classTest` (SUPPORTS_STREAMING_WASI stays false) — the coordination signal
// that steers wasm decompress users to the one-shot API / buffered polyfill.
classTest('concurrency: many simultaneous Decompressors all round-trip (async pool not starved)', async (t) => {
  // 32 concurrent decoders on 64-bit. On the 32-bit leg fewer: 32 decoder worker
  // THREADS plus 32 live 8 MiB dictionaries would themselves strain the address
  // space, and the probe still demonstrates a non-starved pool with a smaller N.
  const N = IS_32BIT ? 8 : 32
  // `INPUT` is constant, so there are only THREE distinct compressed streams (one
  // per namespace). Pre-compress each ONCE and reuse. Do it SEQUENTIALLY: the
  // one-shot `compress` is async native work on the libuv pool, so a `Promise.all`
  // here would run all three ~64 MiB BT4 encoders (see IS_32BIT) concurrently
  // WITHIN this single test — a pile-up the 32-bit CI leg's `ava --serial` cannot
  // prevent (it only serialises whole test CASES, not async work launched inside
  // one). Awaiting each keeps at most one encoder live at a time. Only the DECODER
  // fan-out below is meant to be concurrent — that is what this probe exercises.
  const compressedByNs = {} as Record<Namespace, Buffer>
  for (const ns of NAMESPACES) {
    compressedByNs[ns] = Buffer.from(await oneShot(ns).compress(INPUT))
  }
  const jobs = Array.from({ length: N }, (_unused, i) => {
    const ns = NAMESPACES[i % NAMESPACES.length]
    return { ns, compressed: compressedByNs[ns] }
  })
  // Launch every decompressor at once (each `driveClassDecompress` constructs its
  // Decompressor and synchronously feeds all chunks before returning its
  // finish() promise), then await them together — peak = N live workers.
  const pending = jobs.map(({ ns, compressed }) => driveClassDecompress(ns, chunkBySize(compressed, 5)))
  const restored = await Promise.all(pending)
  restored.forEach((out, i) =>
    t.deepEqual(out, INPUT, `concurrent decompressor #${i} (${jobs[i].ns}) round-trip mismatch`),
  )
})
