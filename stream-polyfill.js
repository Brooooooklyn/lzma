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

module.exports = { bufferAll, singleChunkStream, createStreamApi }
