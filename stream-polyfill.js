// Node-only CJS helper: the inherently Node-only Duplex stream factories.
//
// The pure, browser-safe streaming logic (`createStreamApi` / `honestNamespaces`
// / `bufferAll` / `singleChunkStream`) has ONE source — the ESM module
// `stream-polyfill.mjs` — which every entry point (Node via `require(esm)`,
// browser via `import`) consumes directly. This file holds ONLY the piece that
// cannot be browser-safe: the Node `Duplex` bridge, which needs `node:stream`.
// It is therefore never referenced from any browser condition target, so
// `node:stream` never enters the browser load graph.

'use strict'

/**
 * Build `{ createCompressStream, createDecompressStream }` for one namespace:
 * convenience Node-stream factories that bridge the WHATWG web-stream fns to a
 * ready-to-pipe Node `Duplex`, so `createReadStream().pipe(createCompressStream())`
 * works in one call. Written plaintext is fed through an identity `TransformStream`
 * (the Duplex's writable side) into `compressStream` / `decompressStream`, whose
 * output becomes the Duplex's readable side.
 *
 * `node:stream` is required lazily here (never at module load).
 *
 * @param {object} api
 * @param {Function} api.compressStream    web-stream compressor for the namespace
 * @param {Function} api.decompressStream  web-stream decompressor for the namespace
 */
function createNodeStreamFactories({ compressStream, decompressStream }) {
  const { Duplex } = require('node:stream')
  const bridge = (transform) => (options) => {
    const { readable, writable } = new TransformStream()
    return Duplex.fromWeb({ writable, readable: transform(readable, options) })
  }
  return {
    createCompressStream: bridge(compressStream),
    createDecompressStream: bridge(decompressStream),
  }
}

module.exports = {
  createNodeStreamFactories,
}
