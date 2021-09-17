const binding = require('./index')

module.exports = {
  compress: function compress(input) {
    return binding.lzma2Compress(Buffer.from(input))
  },
  decompress: function decompress(input) {
    return binding.lzma2Decompress(Buffer.from(input))
  },
}
