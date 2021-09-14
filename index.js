const { loadBinding } = require('@node-rs/helper')

module.exports = loadBinding(__dirname, 'lzma', '@napi-rs/lzma')
