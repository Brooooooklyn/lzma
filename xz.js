const { xz, XzCompressor, XzDecompressor } = require('./index')
const { createStreamApi } = require('./stream-polyfill')

module.exports.compress = xz.compress
module.exports.compressSync = xz.compressSync
module.exports.decompress = xz.decompress
module.exports.decompressSync = xz.decompressSync

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
