// Browser-condition type declarations for the `@napi-rs/lzma/xz` subpath.
//
// HAND-AUTHORED to mirror the Uint8Array browser runtime in `xz.browser.js`
// EXACTLY: every chunk / stream / return value is a plain `Uint8Array`, never a
// Node `Buffer`. They are intentionally SELF-CONTAINED — no `import … from
// './index'`, no `typeof`, no `Buffer`, no `node:*` — so a DOM-only TS consumer
// (`lib: ["dom","esnext"]`, no `@types/node`) never hits `Cannot find name
// 'Buffer'`. This is a distinct surface from the Node `Buffer` types in
// `xz.d.ts` (which the Node/default condition keeps, together with the
// `node:stream` Duplex factories `createCompressStream` / `createDecompressStream`).
// The browser wrapper omits those factories, so they are absent here too.

/** Options for the `.xz` streaming compressor. */
export interface CompressorOptions {
  /** Compression preset `0..=9` (default 6). Higher = smaller output, slower. */
  preset?: number
}

export function compress(input: string | Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
export function compressSync(input: string | Uint8Array): Uint8Array
export function decompress(input: Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
export function decompressSync(input: Uint8Array): Uint8Array

/**
 * Compress a `ReadableStream<Uint8Array>` into an `.xz` byte stream (Web Streams
 * in / out — the browser-native way to stream).
 */
export function compressStream(
  input: ReadableStream<Uint8Array>,
  options?: CompressorOptions | null,
): ReadableStream<Uint8Array>
/** Decompress an `.xz` `ReadableStream<Uint8Array>` into a plaintext stream. */
export function decompressStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>

/** Incremental `.xz` compressor (Web/browser surface: Uint8Array in / out). */
export declare class Compressor {
  constructor(options?: CompressorOptions | null)
  /**
   * Feed one chunk. A `string` is UTF-8 encoded (matching the one-shot
   * `compress` convention); a `Uint8Array` is fed verbatim. Returns the bytes
   * produced so far (possibly empty); only the concatenation of every `update()`
   * plus `finish()` is a valid stream.
   */
  update(chunk: string | Uint8Array): Uint8Array
  /** Flush the encoder and resolve to the format trailer. */
  finish(): Promise<Uint8Array>
}

/** Incremental `.xz` decompressor (Web/browser surface: Uint8Array in / out). */
export declare class Decompressor {
  constructor()
  /** Feed one compressed chunk; returns the bytes decoded so far (possibly empty). */
  update(chunk: Uint8Array): Uint8Array
  /** Signal EOF and resolve to the decoded tail. */
  finish(): Promise<Uint8Array>
}
