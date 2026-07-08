// Shared, browser-safe Web Streams helpers + the native-or-polyfill wiring used
// by every entry point (root `main.js` / `browser-entry.js` and the per-namespace
// `xz` / `lzma` / `lzma2` subpaths, in both their Node and browser conditions).
//
// This is the SINGLE SOURCE of the pure streaming logic. It is authored as a real
// ESM module so the browser condition targets (`browser-entry.js`,
// `xz.browser.js`, …) can `import { honestNamespaces } from './stream-polyfill.mjs'`
// as clean ESM. The CJS Node wrappers consume the very same module through the
// thin `stream-polyfill.js` facade, which `require()`s this file (Node >= 22.12
// `require(esm)` returns the namespace; the package engines guarantee it) and adds
// the inherently Node-only Duplex factory. No logic is duplicated.
//
// Load-time browser safety: this module imports NOTHING from `node:*`. The only
// runtime globals it touches are Web Streams (`ReadableStream`) and `Buffer`
// (supplied in the browser by the `@napi-rs/wasm-runtime` binding, exactly as the
// wasm build already relies on for its returned buffers).
//
// On a native build the Rust `compressStream` / `decompressStream` transforms
// exist on the binding and are used directly. On the wasm build those tokio-
// backed fns are compiled out, so `binding.compressStream` is `undefined` and we
// fall back to a buffered polyfill: drain the whole input stream, run it through
// the (tokio-free, target-agnostic) streaming CLASS API — which honours `preset`
// / `dictSize` exactly like the native transform, unlike the one-shot helpers,
// which expose neither — and emit the result as a single-chunk ReadableStream.

/**
 * Drain a Web `ReadableStream<Uint8Array>` fully into a single Buffer. Each
 * chunk is copied (`Buffer.from`) so the result never aliases a reused source
 * buffer.
 */
export async function bufferAll(input) {
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
export function singleChunkStream(produce) {
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
export function createStreamApi({ nativeCompressStream, nativeDecompressStream, Compressor, Decompressor }) {
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
export function honestNamespaces(binding) {
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
