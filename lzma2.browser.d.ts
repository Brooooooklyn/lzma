// Browser-condition type declarations for the `@napi-rs/lzma/lzma2` subpath.
//
// The `browser` export condition maps to `lzma2.browser.js`, the hand-written wasm
// wrapper, which intentionally does NOT export the Node-only `createCompressStream`
// / `createDecompressStream` Duplex factories (they need `node:stream`, which does
// not exist in the browser). These declarations therefore mirror the browser
// wrapper's ACTUAL exports EXACTLY — the one-shot fns, the Web-Streams
// `compressStream` / `decompressStream`, and the streaming classes — and reference
// NOTHING from `node:stream`. The Node/default condition keeps the full
// `lzma2.d.ts` (which additionally declares the Duplex factories). Types are taken
// from `./index` (the universal surface), so nothing here pulls in `node:stream`.

import { lzma2 } from './index'

export const compress: typeof lzma2.compress
export const compressSync: typeof lzma2.compressSync
export const decompress: typeof lzma2.decompress
export const decompressSync: typeof lzma2.decompressSync
export const compressStream: typeof lzma2.compressStream
export const decompressStream: typeof lzma2.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export { Lzma2Compressor as Compressor, Lzma2Decompressor as Decompressor } from './index'
