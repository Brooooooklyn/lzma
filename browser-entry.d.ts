// Browser-condition type declarations for the ROOT `@napi-rs/lzma` entry (the
// `.` export's `browser` condition + the top-level `browser` field target
// `browser-entry.js`).
//
// HAND-AUTHORED to mirror the Uint8Array browser runtime in `browser-entry.js`
// EXACTLY: every chunk / stream / return value is a plain `Uint8Array`, never a
// Node `Buffer`. It is intentionally SELF-CONTAINED — no `import … from
// './index'`, no `typeof`, no `Buffer`, no `node:*`, no `import('node:stream')` —
// so a DOM-only TS consumer (`lib: ["dom","esnext"]`, no `@types/node`) never
// hits `Cannot find name 'Buffer'`. This is a distinct surface from the Node
// `Buffer` types in `index.d.ts` (which the Node/default condition keeps).
//
// It declares EXACTLY what `browser-entry.js` re-exports at runtime: the six
// top-level streaming classes and the three honest namespaces (`lzma`/`lzma2`/
// `xz`), each carrying the Uint8Array-typed one-shot + Web-Streams members. The
// browser entry omits the Node-only `node:stream` Duplex factories
// (`createCompressStream`/`createDecompressStream`), so they are absent here too.
// The per-subpath `*.browser.d.ts` files share these type shapes.

/** Options for the LZMA1 and XZ streaming compressors. */
export interface CompressorOptions {
  /** Compression preset `0..=9` (default 6). Higher = smaller output, slower. */
  preset?: number
}

/**
 * Options for the raw LZMA2 streaming compressor: adds an explicit dictionary
 * size because raw LZMA2 carries none in-band, so encoder and decoder must agree.
 */
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

/** Incremental `.xz` compressor (Web/browser surface: Uint8Array in / out). */
export declare class XzCompressor {
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
export declare class XzDecompressor {
  constructor()
  /** Feed one compressed chunk; returns the bytes decoded so far (possibly empty). */
  update(chunk: Uint8Array): Uint8Array
  /** Signal EOF and resolve to the decoded tail. */
  finish(): Promise<Uint8Array>
}

/** Incremental `.lzma` (LZMA1) compressor (Web/browser surface: Uint8Array in / out). */
export declare class LzmaCompressor {
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

/** Incremental `.lzma` (LZMA1) decompressor (Web/browser surface: Uint8Array in / out). */
export declare class LzmaDecompressor {
  constructor()
  /** Feed one compressed chunk; returns the bytes decoded so far (possibly empty). */
  update(chunk: Uint8Array): Uint8Array
  /** Signal EOF and resolve to the decoded tail. */
  finish(): Promise<Uint8Array>
}

/** Incremental raw LZMA2 compressor (Web/browser surface: Uint8Array in / out). */
export declare class Lzma2Compressor {
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
export declare class Lzma2Decompressor {
  constructor(options?: Lzma2DecompressorOptions | null)
  /** Feed one compressed chunk; returns the bytes decoded so far (possibly empty). */
  update(chunk: Uint8Array): Uint8Array
  /** Signal EOF and resolve to the decoded tail. */
  finish(): Promise<Uint8Array>
}

export declare namespace lzma {
  export function compress(input: string | Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
  export function compressSync(input: string | Uint8Array): Uint8Array
  export function decompress(input: Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
  export function decompressSync(input: Uint8Array): Uint8Array
  /** Compress a `ReadableStream<Uint8Array>` into a `.lzma` byte stream (Web Streams in / out). */
  export function compressStream(
    input: ReadableStream<Uint8Array>,
    options?: CompressorOptions | null,
  ): ReadableStream<Uint8Array>
  /** Decompress a `.lzma` `ReadableStream<Uint8Array>` into a plaintext stream. */
  export function decompressStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
}

export declare namespace lzma2 {
  export function compress(input: string | Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
  export function compressSync(input: string | Uint8Array): Uint8Array
  export function decompress(input: Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
  export function decompressSync(input: Uint8Array): Uint8Array
  /** Compress a `ReadableStream<Uint8Array>` into a raw LZMA2 byte stream (Web Streams in / out). */
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
}

export declare namespace xz {
  export function compress(input: string | Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
  export function compressSync(input: string | Uint8Array): Uint8Array
  export function decompress(input: Uint8Array, signal?: AbortSignal | null): Promise<Uint8Array>
  export function decompressSync(input: Uint8Array): Uint8Array
  /** Compress a `ReadableStream<Uint8Array>` into an `.xz` byte stream (Web Streams in / out). */
  export function compressStream(
    input: ReadableStream<Uint8Array>,
    options?: CompressorOptions | null,
  ): ReadableStream<Uint8Array>
  /** Decompress an `.xz` `ReadableStream<Uint8Array>` into a plaintext stream. */
  export function decompressStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
}
