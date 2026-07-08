/**
 * Shared streaming-test helpers + the FROZEN public class-name decision.
 *
 * ── DECISION (T1 namespace-class-name spike) ────────────────────────────────
 * The streaming classes that T2/T3 add live at the TOP LEVEL of the native
 * binding (they are NOT namespaced):
 *
 *   lzma  -> LzmaCompressor  / LzmaDecompressor
 *   lzma2 -> Lzma2Compressor / Lzma2Decompressor
 *   xz    -> XzCompressor    / XzDecompressor
 *
 * Why not the namespaced `lzma.Compressor` / `xz.Compressor` shape (which the
 * existing FUNCTIONS use)? The spike registered two throwaway `#[napi]` classes
 * both named `Compressor`, one under `namespace = "lzma"` and one under
 * `namespace = "xz"`. Observed with @napi-rs/cli 3.7.2 (local; CI runs a newer
 * 3.x):
 *   - Runtime (index.js): fine — `lzma.Compressor` and `xz.Compressor` resolved
 *     to distinct constructors with the correct methods.
 *   - Types (index.d.ts): BROKEN — the `.d.ts` generator groups class members by
 *     the bare JS class name, so `lzma.Compressor` emitted an EMPTY body while
 *     `xz.Compressor` got BOTH classes' `constructor()`/method entries,
 *     duplicated. Adding `js_name = "Compressor"` to the struct does not compile
 *     in 3.7.2 (`error: unused #[napi] attribute`), so there is no escape hatch
 *     that keeps a shared `Compressor` JS name across namespaces.
 *   - Top-level distinct names (`LzmaCompressor` + `XzCompressor`) produced a
 *     clean `.d.ts` AND a clean runtime.
 * => We freeze the top-level distinct names above.
 *
 * Caveat: CI uses a newer 3.x cli. The namespaced-collision-vs-top-level outcome
 * is expected to be stable across 3.x, but if a future cli fixes the `.d.ts`
 * member grouping, this decision (and the class names below) may be revisited.
 *
 * The class accessors resolve LAZILY (they `require` at call time) so this file
 * imports and type-checks cleanly TODAY, before T2/T3 create the classes.
 */
import { createRequire } from 'node:module'

import * as lzmaOneShot from '../lzma'
import * as lzma2OneShot from '../lzma2'
import * as xzOneShot from '../xz'

// `require` is not a global under the ESM test loader (@oxc-node), so build one
// bound to this file. Used only to lazily resolve the native classes below.
const requireFrom = createRequire(import.meta.url)

export type Namespace = 'lzma' | 'lzma2' | 'xz'

/** A newable native class. T2/T3 pin the concrete instance / options shape. */
export type NativeCtor<T = unknown> = new (...args: any[]) => T

/** Frozen top-level JS names of the streaming classes (see file header). */
export const COMPRESSOR_CLASS: Record<Namespace, string> = {
  lzma: 'LzmaCompressor',
  lzma2: 'Lzma2Compressor',
  xz: 'XzCompressor',
}

export const DECOMPRESSOR_CLASS: Record<Namespace, string> = {
  lzma: 'LzmaDecompressor',
  lzma2: 'Lzma2Decompressor',
  xz: 'XzDecompressor',
}

const loadClass = <T>(className: string): NativeCtor<T> => {
  // Resolve at call time: the classes do not exist until T2/T3 land, so a
  // top-level import must not hard-fail today.
  const binding = requireFrom('../index.js') as Record<string, unknown>
  const ctor = binding[className]
  if (typeof ctor !== 'function') {
    throw new Error(`Native class \`${className}\` is not on the binding yet (added by T2/T3); got ${typeof ctor}.`)
  }
  return ctor as NativeCtor<T>
}

/** Resolve the streaming Compressor class for a namespace (lazy). */
export const loadCompressor = <T = unknown>(ns: Namespace): NativeCtor<T> => loadClass<T>(COMPRESSOR_CLASS[ns])

/** Resolve the streaming Decompressor class for a namespace (lazy). */
export const loadDecompressor = <T = unknown>(ns: Namespace): NativeCtor<T> => loadClass<T>(DECOMPRESSOR_CLASS[ns])

/** The existing per-namespace one-shot API, re-exported for cross-checks. */
export interface OneShot {
  compress(input: string | Uint8Array, signal?: AbortSignal | null): Promise<Buffer>
  compressSync(input: string | Uint8Array): Buffer
  decompress(input: Uint8Array, signal?: AbortSignal | null): Promise<Buffer>
  decompressSync(input: Uint8Array): Buffer
}

const ONE_SHOT: Record<Namespace, OneShot> = {
  lzma: lzmaOneShot,
  lzma2: lzma2OneShot,
  xz: xzOneShot,
}

/** The one-shot compress/decompress helpers for a namespace. */
export const oneShot = (ns: Namespace): OneShot => ONE_SHOT[ns]

// ── Shared fixtures ─────────────────────────────────────────────────────────

/**
 * Deterministic low-entropy bytes (16-symbol alphabet) — compressible. Matches
 * the generator already used by the existing per-namespace specs.
 */
export const lowEntropyBytes = (size: number): Buffer => {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) {
    buf[i] = (Math.imul(i, 2654435761) >>> 24) & 0x0f
  }
  return buf
}

/**
 * Deterministic full-range bytes (xorshift32) — reproducible yet high-entropy,
 * for the incompressible / random path without pulling in `crypto`.
 */
export const deterministicBytes = (size: number, seed = 0x9e3779b9): Buffer => {
  const buf = Buffer.allocUnsafe(size)
  let state = seed >>> 0 || 1
  for (let i = 0; i < size; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    buf[i] = state & 0xff
  }
  return buf
}

/** Split a buffer into fixed `size`-byte chunks (the final chunk may be shorter). */
export const chunkBySize = (buf: Buffer, size: number): Buffer[] => {
  if (size < 1) {
    throw new Error(`chunk size must be >= 1, got ${size}`)
  }
  const chunks: Buffer[] = []
  for (let offset = 0; offset < buf.length; offset += size) {
    chunks.push(buf.subarray(offset, Math.min(offset + size, buf.length)))
  }
  return chunks
}

/** Split a buffer into 1-byte chunks (worst-case boundary stress). */
export const chunkByByte = (buf: Buffer): Buffer[] => chunkBySize(buf, 1)

/**
 * Split a buffer using a repeating, deliberately awkward size pattern so chunk
 * boundaries never line up with internal block / dictionary sizes.
 */
export const awkwardChunks = (buf: Buffer, pattern: readonly number[] = [1, 2, 3, 5, 7, 11, 13]): Buffer[] => {
  if (pattern.length === 0 || pattern.some((n) => n < 1)) {
    throw new Error('awkward chunk pattern must be non-empty with every size >= 1')
  }
  const chunks: Buffer[] = []
  let offset = 0
  let i = 0
  while (offset < buf.length) {
    const size = pattern[i % pattern.length]
    chunks.push(buf.subarray(offset, Math.min(offset + size, buf.length)))
    offset += size
    i++
  }
  return chunks
}
