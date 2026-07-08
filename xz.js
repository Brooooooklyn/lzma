const { xz, XzCompressor, XzDecompressor } = require('./index')
const { createStreamApi, createNodeStreamFactories } = require('./stream-polyfill')

module.exports.compress = xz.compress
module.exports.compressSync = xz.compressSync
module.exports.decompress = xz.decompress
module.exports.decompressSync = xz.decompressSync

// Streaming compressor/decompressor classes, exposed under the namespace-local
// names `Compressor` / `Decompressor` (the binding registers them top-level with
// distinct names to keep `.d.ts` codegen clean — see `src/stream.rs`).
module.exports.Compressor = XzCompressor
module.exports.Decompressor = XzDecompressor

// Native transforms when present (non-wasm); a buffered class-API polyfill on
// the wasm build, where the tokio-backed native fns are compiled out.
const { compressStream, decompressStream } = createStreamApi({
  nativeCompressStream: xz.compressStream,
  nativeDecompressStream: xz.decompressStream,
  Compressor: XzCompressor,
  Decompressor: XzDecompressor,
})

module.exports.compressStream = compressStream
module.exports.decompressStream = decompressStream

// Convenience Node-stream factories: ready-to-pipe `Duplex`es bridging the
// web-stream fns, so `createReadStream().pipe(xz.createCompressStream())` works.
const { createCompressStream, createDecompressStream } = createNodeStreamFactories({
  compressStream,
  decompressStream,
})

module.exports.createCompressStream = createCompressStream
module.exports.createDecompressStream = createDecompressStream
