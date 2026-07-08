// Browser-condition type declarations for the `@napi-rs/lzma/lzma2` subpath.
//
// HAND-AUTHORED to mirror the Uint8Array browser runtime in `lzma2.browser.js`
// EXACTLY: every chunk / stream / return value is a plain `Uint8Array`, never a
// Node `Buffer`. They are intentionally SELF-CONTAINED — no `import … from
// './index'`, no `typeof`, no `Buffer`, no `node:*` — so a DOM-only TS consumer
// (`lib: ["dom","esnext"]`, no `@types/node`) never hits `Cannot find name
// 'Buffer'`. This is a distinct surface from the Node `Buffer` types in
// `lzma2.d.ts` (which the Node/default condition keeps, together with the
// `node:stream` Duplex factories `createCompressStream` / `createDecompressStream`).
// The browser wrapper omits those factories, so they are absent here too.
//
// Raw LZMA2 carries no dictionary size in-band, so both the compressor and the
// decompressor accept an explicit `dictSize`; encoder and decoder must agree.

/** Options for the raw LZMA2 streaming compressor. */
export interface Lzma2CompressorOptions {
  /** Compression preset `0..=9` (default 6). Higher = smaller output, slower. */
  preset?: number
  /** Dictionary size in bytes (defaults to 8 MiB). */
  dictSize?: number
}

/** Options for the raw LZMA2 streaming decompressor. */
export interface Lzma2DecompressorOptions {
  /** Dictionary size in bytes (defaults to 8 MiB; MUST match the encoder). */
  dictSize?: number
}

export function compress(input: string | Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
export function compressSync(input: string | Uint8Array): Uint8Array
export function decompress(input: Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
export function decompressSync(input: Uint8Array): Uint8Array

/**
 * Compress a `ReadableStream<Uint8Array>` into a raw LZMA2 byte stream (Web
 * Streams in / out — the browser-native way to stream).
 */
export function compressStream(
  input: ReadableStream<Uint8Array>,
  options?: Lzma2CompressorOptions | null,
): ReadableStream<Uint8Array>
/**
 * Decompress a raw LZMA2 `ReadableStream<Uint8Array>` into a plaintext stream.
 * `options.dictSize` must match the encoder (raw LZMA2 carries none in-band).
 */
export function decompressStream(
  input: ReadableStream<Uint8Array>,
  options?: Lzma2DecompressorOptions | null,
): ReadableStream<Uint8Array>

/** Incremental raw LZMA2 compressor (Web/browser surface: Uint8Array in / out). */
export declare class Compressor {
  constructor(options?: Lzma2CompressorOptions | null)
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

/** Incremental raw LZMA2 decompressor (Web/browser surface: Uint8Array in / out). */
export declare class Decompressor {
  constructor(options?: Lzma2DecompressorOptions | null)
  /** Feed one compressed chunk; returns the bytes decoded so far (possibly empty). */
  update(chunk: Uint8Array): Uint8Array
  /** Signal EOF and resolve to the decoded tail. */
  finish(): Promise<Uint8Array>
}
