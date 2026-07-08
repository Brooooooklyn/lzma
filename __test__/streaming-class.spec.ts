import { createRequire } from 'node:module'

import test from 'ava'

import { chunkBySize, chunkByByte, driveClassCompress, oneShot, type Namespace } from './helpers'

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

// ── Strict C-decode: validates the trailer/footer/end-marker is well-formed ──
// When not WASI and `lzma-native` is present, decode our class output with the C
// implementation for xz and lzma. Degrade gracefully (skip) otherwise.

type NativeDecode = (buf: Buffer) => Promise<Buffer>

const nativeStrictDecode: Partial<Record<Namespace, NativeDecode>> = {}

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
  } catch {
    // `lzma-native` not installed / not buildable on this platform: the strict
    // legs below self-skip, mirroring the existing per-namespace specs.
  }
}

for (const ns of ['xz', 'lzma'] as const) {
  test(`${ns}: class output is strictly decodable by lzma-native`, async (t) => {
    const decode = nativeStrictDecode[ns]
    if (!decode) {
      t.pass(`lzma-native unavailable (${IS_WASI ? 'WASI' : 'not installed'}); skipping strict C-decode`)
      return
    }
    const compressed = await driveClassCompress(ns, chunkBySize(INPUT, 64))
    const restored = await decode(compressed)
    t.deepEqual(Buffer.from(restored), INPUT)
  })
}
