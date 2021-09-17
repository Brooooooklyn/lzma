const binding = require('./index')

module.exports.compress = function compress(input) {
  return binding.lzmaCompress(Buffer.from(input))
}

module.exports.decompress = function decompress(input) {
  return binding.lzmaDecompress(Buffer.from(input))
}
