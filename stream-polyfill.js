// Shared Web Streams helpers + the native-or-polyfill wiring used by the
// per-namespace entry points (`xz.js` / `lzma.js` / `lzma2.js`).
//
// On a native build the Rust `compressStream` / `decompressStream` transforms
// exist on the binding and are used directly. On the wasm build those tokio-
// backed fns are compiled out, so `binding.compressStream` is `undefined` and we
// fall back to a buffered polyfill: drain the whole input stream, run it through
// the (tokio-free, target-agnostic) streaming CLASS API — which honours `preset`
// / `dictSize` exactly like the native transform, unlike the one-shot helpers,
// which expose neither — and emit the result as a single-chunk ReadableStream.

'use strict'

/**
 * Drain a Web `ReadableStream<Uint8Array>` fully into a single Buffer. Each
 * chunk is copied (`Buffer.from`) so the result never aliases a reused source
 * buffer.
 */
async function bufferAll(input) {
  const reader = input.getReader()
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length) {
        chunks.push(Buffer.from(value))
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Best-effort: an already-released/closed reader is fine.
    }
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
}

/**
 * Wrap an async `() => Promise<Buffer>` producer as a single-chunk
 * `ReadableStream`. The whole payload is produced on the first `pull`; a
 * producer rejection errors the stream (parity with the native transform, which
 * errors rather than truncating).
 */
function singleChunkStream(produce) {
  let emitted = false
  return new ReadableStream({
    async pull(controller) {
      if (emitted) {
        return
      }
      emitted = true
      try {
        const out = await produce()
        if (out && out.length) {
          controller.enqueue(out)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Build `{ compressStream, decompressStream }` for one namespace: the native
 * transforms when present, otherwise a buffered class-API polyfill.
 *
 * @param {object} spec
 * @param {Function|undefined} spec.nativeCompressStream   `binding.<ns>.compressStream`
 * @param {Function|undefined} spec.nativeDecompressStream  `binding.<ns>.decompressStream`
 * @param {Function} spec.Compressor    streaming compressor class (honours `options`)
 * @param {Function} spec.Decompressor  streaming decompressor class (honours `options`)
 */
function createStreamApi({ nativeCompressStream, nativeDecompressStream, Compressor, Decompressor }) {
  const compressStream =
    typeof nativeCompressStream === 'function'
      ? nativeCompressStream
      : (input, options) =>
          singleChunkStream(async () => {
            const compressor = new Compressor(options)
            const head = Buffer.from(await compressor.update(await bufferAll(input)))
            const tail = Buffer.from(await compressor.finish())
            return head.length ? (tail.length ? Buffer.concat([head, tail]) : head) : tail
          })

  const decompressStream =
    typeof nativeDecompressStream === 'function'
      ? nativeDecompressStream
      : (input, options) =>
          singleChunkStream(async () => {
            const decompressor = new Decompressor(options)
            const head = Buffer.from(await decompressor.update(await bufferAll(input)))
            const tail = Buffer.from(await decompressor.finish())
            return head.length ? (tail.length ? Buffer.concat([head, tail]) : head) : tail
          })

  return { compressStream, decompressStream }
}

/**
 * The three namespaces and their top-level streaming class names, so the root /
 * browser entries can polyfill a missing `compressStream` / `decompressStream`
 * from the (tokio-free, always-present) class API.
 */
const NAMESPACE_CLASSES = [
  ['lzma', 'LzmaCompressor', 'LzmaDecompressor'],
  ['lzma2', 'Lzma2Compressor', 'Lzma2Decompressor'],
  ['xz', 'XzCompressor', 'XzDecompressor'],
]

/**
 * Return honest `{ lzma, lzma2, xz }` namespace objects for a loaded binding: on
 * a native build each namespace already carries `compressStream` /
 * `decompressStream` and is returned unchanged; on the wasm build those tokio-
 * backed fns are compiled out, so a shim inheriting from the raw namespace (via
 * `Object.create`, so `compress`/`decompressSync`/… still resolve) is returned
 * with the two stream fns filled in from the class-API polyfill. The raw
 * namespace object is NEVER mutated, so `require('./index').<ns>` keeps exposing
 * the true native surface (used by the tests' native-detection gate).
 *
 * @param {Record<string, unknown>} binding  the loaded napi binding (classes + namespaces)
 * @returns {Record<'lzma'|'lzma2'|'xz', object>}
 */
function honestNamespaces(binding) {
  const out = {}
  for (const [ns, compressorName, decompressorName] of NAMESPACE_CLASSES) {
    const namespace = binding[ns]
    if (!namespace) {
      continue
    }
    if (typeof namespace.compressStream === 'function') {
      // Native build: the real tokio transforms are already present.
      out[ns] = namespace
      continue
    }
    // wasm / stream-less build: fill the two fns from the class-API polyfill.
    const { compressStream, decompressStream } = createStreamApi({
      nativeCompressStream: namespace.compressStream,
      nativeDecompressStream: namespace.decompressStream,
      Compressor: binding[compressorName],
      Decompressor: binding[decompressorName],
    })
    const shim = Object.create(namespace)
    shim.compressStream = compressStream
    shim.decompressStream = decompressStream
    out[ns] = shim
  }
  return out
}

/**
 * Build `{ createCompressStream, createDecompressStream }` for one namespace:
 * convenience Node-stream factories that bridge the WHATWG web-stream fns to a
 * ready-to-pipe Node `Duplex`, so `createReadStream().pipe(createCompressStream())`
 * works in one call. Written plaintext is fed through an identity `TransformStream`
 * (the Duplex's writable side) into `compressStream` / `decompressStream`, whose
 * output becomes the Duplex's readable side.
 *
 * `node:stream` is required lazily here (never at module load) so this file stays
 * importable from the browser entry, which only uses `createStreamApi` /
 * `honestNamespaces`.
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
  bufferAll,
  singleChunkStream,
  createStreamApi,
  honestNamespaces,
  createNodeStreamFactories,
}
