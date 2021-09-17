const binding = require('./index')

module.exports.compress = function compress(input) {
  return binding.lzma2Compress(Buffer.from(input))
}

module.exports.decompress = function decompress(input) {
  return binding.lzma2Decompress(Buffer.from(input))
}
