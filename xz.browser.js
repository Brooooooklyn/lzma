// Honest browser / wasm entry for the `@napi-rs/lzma/xz` subpath (its `browser`
// export condition + `browser`-field target).
//
// Unlike the Node wrapper `xz.js`, which `require('./index')` (the NATIVE addon
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
// `xz.d.ts` still declares the factories for the Node condition.

import * as binding from '@napi-rs/lzma-wasm32-wasi'
import { honestNamespaces } from './stream-polyfill.mjs'

const { xz } = honestNamespaces(binding)

export const compress = xz.compress
export const compressSync = xz.compressSync
export const decompress = xz.decompress
export const decompressSync = xz.decompressSync

// Native transforms are absent on wasm, so these are the buffered class-API
// polyfill (Web Streams in / out).
export const compressStream = xz.compressStream
export const decompressStream = xz.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export const Compressor = binding.XzCompressor
export const Decompressor = binding.XzDecompressor
