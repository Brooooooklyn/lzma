const { lzma, LzmaCompressor, LzmaDecompressor } = require('./index')
const { createStreamApi } = require('./stream-polyfill')

module.exports.compress = lzma.compress
module.exports.compressSync = lzma.compressSync
module.exports.decompress = lzma.decompress
module.exports.decompressSync = lzma.decompressSync

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
