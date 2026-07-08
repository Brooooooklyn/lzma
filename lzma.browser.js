// Honest browser / wasm entry for the `@napi-rs/lzma/lzma` subpath (its `browser`
// export condition + `browser`-field target).
//
// Unlike the Node wrapper `lzma.js`, which `require('./index')` (the NATIVE addon
// loader), this imports the wasm binding directly and never touches the `.node`.
// The wasm build compiles out the tokio-backed `compressStream` / `decompressStream`
// transforms, so `honestNamespaces` fills them in from the (target-agnostic)
// streaming class API — the same single-sourced polyfill the root browser entry
// uses. Clean ESM: the shared helper is imported from `./stream-polyfill.mjs`.
//
// The Node-Duplex `createCompressStream` / `createDecompressStream` factories are
// deliberately OMITTED here: they need `node:stream`, which does not exist in the
// browser, and their Web-Streams equivalents (`compressStream` / `decompressStream`,
// exported below) are the browser-native way to stream. The shared subpath
// `lzma.d.ts` still declares the factories for the Node condition.

import * as binding from '@napi-rs/lzma-wasm32-wasi'
import { honestNamespaces } from './stream-polyfill.mjs'

const { lzma } = honestNamespaces(binding)

export const compress = lzma.compress
export const compressSync = lzma.compressSync
export const decompress = lzma.decompress
export const decompressSync = lzma.decompressSync

// Native transforms are absent on wasm, so these are the buffered class-API
// polyfill (Web Streams in / out).
export const compressStream = lzma.compressStream
export const decompressStream = lzma.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export const Compressor = binding.LzmaCompressor
export const Decompressor = binding.LzmaDecompressor
