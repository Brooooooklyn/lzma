const { lzma2, Lzma2Compressor, Lzma2Decompressor } = require('./index')
// Pure streaming logic from the single-source ESM module (Node `require(esm)`);
// the Node-only Duplex factory from its CJS sibling.
const { createStreamApi } = require('./stream-polyfill.mjs')
const { createNodeStreamFactories } = require('./stream-polyfill.js')

module.exports.compress = lzma2.compress
module.exports.compressSync = lzma2.compressSync
module.exports.decompress = lzma2.decompress
module.exports.decompressSync = lzma2.decompressSync

// Streaming compressor/decompressor classes, exposed under the namespace-local
// names `Compressor` / `Decompressor` (the binding registers them top-level with
// distinct names to keep `.d.ts` codegen clean — see `src/stream.rs`).
module.exports.Compressor = Lzma2Compressor
module.exports.Decompressor = Lzma2Decompressor

// Native transforms when present (non-wasm); a buffered class-API polyfill on
// the wasm build, where the tokio-backed native fns are compiled out. The
// polyfill threads `dictSize` through the class ctors so raw LZMA2 round-trips.
const { compressStream, decompressStream } = createStreamApi({
  nativeCompressStream: lzma2.compressStream,
  nativeDecompressStream: lzma2.decompressStream,
  Compressor: Lzma2Compressor,
  Decompressor: Lzma2Decompressor,
})

module.exports.compressStream = compressStream
module.exports.decompressStream = decompressStream

// Convenience Node-stream factories: ready-to-pipe `Duplex`es bridging the
// web-stream fns, so `createReadStream().pipe(lzma2.createCompressStream())` works.
const { createCompressStream, createDecompressStream } = createNodeStreamFactories({
  compressStream,
  decompressStream,
})

module.exports.createCompressStream = createCompressStream
module.exports.createDecompressStream = createDecompressStream
