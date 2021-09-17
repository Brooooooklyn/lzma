const binding = require('./index')

module.exports.compress = function compress(input) {
  return binding.xzCompress(Buffer.from(input))
}

module.exports.decompress = function decompress(input) {
  return binding.xzDecompress(Buffer.from(input))
}
