const binding = require('./index')

module.exports = {
  compress: function compress(input) {
    return binding.compress(Buffer.from(input))
  },
  decompress: binding.decompress,
}
