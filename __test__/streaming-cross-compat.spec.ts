/**
 * T6 — Cross-implementation compatibility matrix for the streaming APIs.
 *
 * The xz/lzma streaming surfaces (class + web) must interoperate with BOTH our
 * own one-shot codec AND an independent C implementation (`lzma-native`/liblzma).
 * The four matrix cells the brief calls out, and where each is tested:
 *
 *   direction                         │ class                         │ web
 *   ──────────────────────────────────┼───────────────────────────────┼──────────────────────
 *   stream-compress → one-shot-decode │ streaming-class.spec (§round) │ streaming-web.spec §2
 *   one-shot-compress → stream-decode │ streaming-class.spec §1       │ streaming-web.spec §2
 *   C-compress → stream-decode        │ ► THIS FILE                   │ streaming-web.spec §4
 *   stream-compress → C-decode        │ streaming-class.spec (strict) │ ► THIS FILE
 *
 * This file adds the two remaining C(lzma-native)-interop cells — `C → class` and
 * `web → C` — so ALL FOUR external-codec directions (class→C, C→class, web→C,
 * C→web) are covered across the suite. `lzma2` has no `lzma-native` container, so
 * its stream↔one-shot interop is covered by the class/web round-trip suites, not
 * here. The internal stream↔one-shot cells above are NOT restated here.
 *
 * `lzma-native` legitimately cannot load on some targets (WASI; the qemu-docker
 * s390x / ppc64le / riscv64 / armv7 / aarch64-musl legs ship no prebuild), so each
 * leg registers as a genuine ava SKIP — never a silent pass, never a hard failure.
 */
import test from 'ava'

import * as lzmaStream from '../lzma'
import * as xzStream from '../xz'
import {
  chunkBySize,
  collectStream,
  driveClassDecompress,
  fromChunks,
  loadLzmaNative,
  type LzmaNativeOracle,
  type Namespace,
} from './helpers'

const INPUT = Buffer.from('cross-compat 🚀 xz/lzma interop — Ünïcöde '.repeat(500), 'utf8')

// Only xz and lzma have a matching `lzma-native` container.
const C_FORMATS = ['xz', 'lzma'] as const
type CFormat = (typeof C_FORMATS)[number]

const oracle: LzmaNativeOracle | null = loadLzmaNative()
// Native web transforms exist only on a native build (compiled out on wasm).
const NATIVE_STREAM = typeof (xzStream as { compressStream?: unknown }).compressStream === 'function'

// `lzma-native` present → run; absent (WASI / prebuild-less arch) → honest SKIP.
const cTest = oracle ? test : test.skip
// Web cross-checks additionally need the native transform present.
const webCTest = oracle && NATIVE_STREAM ? test : test.skip

const cEncode: Record<CFormat, (buf: Uint8Array) => Promise<Buffer>> = {
  xz: (buf) => oracle!.encodeXz(buf),
  lzma: (buf) => oracle!.encodeLzma(buf),
}
const cDecode: Record<CFormat, (buf: Uint8Array) => Promise<Buffer>> = {
  xz: (buf) => oracle!.decodeXz(buf),
  lzma: (buf) => oracle!.decodeLzma(buf),
}

type StreamFn = (input: ReadableStream<Uint8Array>, options?: unknown) => ReadableStream<Uint8Array>
const compressStreamOf: Record<CFormat, StreamFn> = {
  xz: (xzStream as unknown as { compressStream: StreamFn }).compressStream,
  lzma: (lzmaStream as unknown as { compressStream: StreamFn }).compressStream,
}

// ── C-compress → CLASS-decompress ────────────────────────────────────────────
// An `lzma-native`-produced stream, split into deliberately tiny chunks, must
// decode incrementally through our streaming CLASS decompressor. Proves the class
// worker accepts a foreign-but-valid encoder's framing at arbitrary boundaries.

for (const ns of C_FORMATS) {
  cTest(`${ns}: C(lzma-native)-compressed stream decodes through the class decompressor`, async (t) => {
    const compressed = await cEncode[ns](INPUT)
    const restored = await driveClassDecompress(ns as Namespace, chunkBySize(compressed, 9))
    t.deepEqual(restored, INPUT)
  })
}

// ── STREAM(web)-compress → C-decompress ──────────────────────────────────────
// Our web transform's output must be strictly decodable by liblzma — real
// coverage that the emitted footer / end-marker is well-formed for an independent
// implementation, not merely round-trip-able through our own decoder.

for (const ns of C_FORMATS) {
  webCTest(`${ns}: web-compressed stream is strictly decodable by C(lzma-native)`, async (t) => {
    const compressed = await collectStream(compressStreamOf[ns](fromChunks(chunkBySize(INPUT, 128))))
    const restored = await cDecode[ns](compressed)
    t.deepEqual(Buffer.from(restored), INPUT)
  })
}
