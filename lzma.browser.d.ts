// Browser-condition type declarations for the `@napi-rs/lzma/lzma` subpath.
//
// The `browser` export condition maps to `lzma.browser.js`, the hand-written wasm
// wrapper, which intentionally does NOT export the Node-only `createCompressStream`
// / `createDecompressStream` Duplex factories (they need `node:stream`, which does
// not exist in the browser). These declarations therefore mirror the browser
// wrapper's ACTUAL exports EXACTLY — the one-shot fns, the Web-Streams
// `compressStream` / `decompressStream`, and the streaming classes — and reference
// NOTHING from `node:stream`. The Node/default condition keeps the full `lzma.d.ts`
// (which additionally declares the Duplex factories). Types are taken from
// `./index` (the universal surface), so nothing here pulls in `node:stream`.

import { lzma } from './index'

export const compress: typeof lzma.compress
export const compressSync: typeof lzma.compressSync
export const decompress: typeof lzma.decompress
export const decompressSync: typeof lzma.decompressSync
export const compressStream: typeof lzma.compressStream
export const decompressStream: typeof lzma.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export { LzmaCompressor as Compressor, LzmaDecompressor as Decompressor } from './index'
