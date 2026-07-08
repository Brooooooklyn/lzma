// Honest browser / wasm entry for `@napi-rs/lzma` (the `.` export's `browser`
// condition + the top-level `browser` field target).
//
// The napi-generated `browser.js` is `export * from '@napi-rs/lzma-wasm32-wasi'`
// and is REWRITTEN on every `napi build`, so it can't durably carry the polyfill.
// The wasm build also compiles out the tokio-backed `compressStream` /
// `decompressStream` transforms, so those raw namespaces lack them even though
// the universal `index.d.ts` advertises them for every target.
//
// This hand-written wrapper (never touched by codegen) imports the wasm binding
// directly, swaps in honest namespaces via the buffered class-API polyfill (see
// `honestNamespaces`), and re-exports the streaming classes unchanged.

import * as binding from '@napi-rs/lzma-wasm32-wasi'
import { honestNamespaces } from './stream-polyfill.js'

const { lzma, lzma2, xz } = honestNamespaces(binding)

export const Lzma2Compressor = binding.Lzma2Compressor
export const Lzma2Decompressor = binding.Lzma2Decompressor
export const LzmaCompressor = binding.LzmaCompressor
export const LzmaDecompressor = binding.LzmaDecompressor
export const XzCompressor = binding.XzCompressor
export const XzDecompressor = binding.XzDecompressor
export { lzma, lzma2, xz }
