const { lzma2, Lzma2Compressor, Lzma2Decompressor } = require('./index')
const { createStreamApi } = require('./stream-polyfill')

module.exports.compress = lzma2.compress
module.exports.compressSync = lzma2.compressSync
module.exports.decompress = lzma2.decompress
module.exports.decompressSync = lzma2.decompressSync

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
