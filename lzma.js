const { lzma, LzmaCompressor, LzmaDecompressor } = require('./index')
const { createStreamApi, createNodeStreamFactories } = require('./stream-polyfill')

module.exports.compress = lzma.compress
module.exports.compressSync = lzma.compressSync
module.exports.decompress = lzma.decompress
module.exports.decompressSync = lzma.decompressSync

// Streaming compressor/decompressor classes, exposed under the namespace-local
// names `Compressor` / `Decompressor` (the binding registers them top-level with
// distinct names to keep `.d.ts` codegen clean — see `src/stream.rs`).
module.exports.Compressor = LzmaCompressor
module.exports.Decompressor = LzmaDecompressor

// Native transforms when present (non-wasm); a buffered class-API polyfill on
// the wasm build, where the tokio-backed native fns are compiled out.
const { compressStream, decompressStream } = createStreamApi({
  nativeCompressStream: lzma.compressStream,
  nativeDecompressStream: lzma.decompressStream,
  Compressor: LzmaCompressor,
  Decompressor: LzmaDecompressor,
})

module.exports.compressStream = compressStream
module.exports.decompressStream = decompressStream

// Convenience Node-stream factories: ready-to-pipe `Duplex`es bridging the
// web-stream fns, so `createReadStream().pipe(lzma.createCompressStream())` works.
const { createCompressStream, createDecompressStream } = createNodeStreamFactories({
  compressStream,
  decompressStream,
})

module.exports.createCompressStream = createCompressStream
module.exports.createDecompressStream = createDecompressStream
