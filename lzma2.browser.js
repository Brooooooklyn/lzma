// Honest browser / wasm entry for the `@napi-rs/lzma/lzma2` subpath (its `browser`
// export condition + `browser`-field target).
//
// Unlike the Node wrapper `lzma2.js`, which `require('./index')` (the NATIVE addon
// loader), this imports the wasm binding directly and never touches the `.node`.
// The wasm build compiles out the tokio-backed `compressStream` / `decompressStream`
// transforms, so `honestNamespaces` fills them in from the (target-agnostic)
// streaming class API — the polyfill threads `dictSize` through the class ctors so
// raw LZMA2 round-trips. Clean ESM: the shared helper is imported from
// `./stream-polyfill.mjs`.
//
// The Node-Duplex `createCompressStream` / `createDecompressStream` factories are
// deliberately OMITTED here: they need `node:stream`, which does not exist in the
// browser, and their Web-Streams equivalents (`compressStream` / `decompressStream`,
// exported below) are the browser-native way to stream. The shared subpath
// `lzma2.d.ts` still declares the factories for the Node condition.

import * as binding from '@napi-rs/lzma-wasm32-wasi'
import { honestNamespaces } from './stream-polyfill.mjs'

const { lzma2 } = honestNamespaces(binding)

export const compress = lzma2.compress
export const compressSync = lzma2.compressSync
export const decompress = lzma2.decompress
export const decompressSync = lzma2.decompressSync

// Native transforms are absent on wasm, so these are the buffered class-API
// polyfill (Web Streams in / out).
export const compressStream = lzma2.compressStream
export const decompressStream = lzma2.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export const Compressor = binding.Lzma2Compressor
export const Decompressor = binding.Lzma2Decompressor
