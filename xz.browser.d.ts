// Browser-condition type declarations for the `@napi-rs/lzma/xz` subpath.
//
// The `browser` export condition maps to `xz.browser.js`, the hand-written wasm
// wrapper, which intentionally does NOT export the Node-only `createCompressStream`
// / `createDecompressStream` Duplex factories (they need `node:stream`, which does
// not exist in the browser). These declarations therefore mirror the browser
// wrapper's ACTUAL exports EXACTLY — the one-shot fns, the Web-Streams
// `compressStream` / `decompressStream`, and the streaming classes — and reference
// NOTHING from `node:stream`. The Node/default condition keeps the full `xz.d.ts`
// (which additionally declares the Duplex factories). Types are taken from
// `./index` (the universal surface), so nothing here pulls in `node:stream`.

import { xz } from './index'

export const compress: typeof xz.compress
export const compressSync: typeof xz.compressSync
export const decompress: typeof xz.decompress
export const decompressSync: typeof xz.decompressSync
export const compressStream: typeof xz.compressStream
export const decompressStream: typeof xz.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export { XzCompressor as Compressor, XzDecompressor as Decompressor } from './index'
