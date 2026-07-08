// Buffer-free probe for the browser-shared stream polyfill (`stream-polyfill.mjs`).
//
// Run standalone by `buffer-free-polyfill.spec.ts` in a child `node` process that
// FIRST deletes `globalThis.Buffer`, faithfully simulating a real browser / the
// `@napi-rs/wasm-runtime` binding, NEITHER of which defines a `Buffer` global.
// It then forces the buffered class-API polyfill path (native stream fns absent)
// and round-trips through `compressStream` → `decompressStream`. If the polyfill
// referenced `Buffer` (the pre-fix code did: `Buffer.from` / `Buffer.concat`), the
// first `pull` throws `Buffer is not defined` — the deterministic RED signal.
//
// This is a plain ESM module (no TypeScript), so the child runs bare `node`
// without the ava/@oxc-node loader. Success prints exactly `BUFFER_FREE_PROBE_OK`.
import { createRequire } from 'node:module'

import { createStreamApi } from '../stream-polyfill.mjs'

// Load the target-agnostic streaming classes from the binding FIRST (the binding
// LOADER is not the code under test, and requiring it with a Buffer global present
// keeps this probe robust across every target's loader — native or wasm).
const require = createRequire(import.meta.url)
const binding = require('../index.js')

// NOW simulate a real browser / the `@napi-rs/wasm-runtime` binding: no `Buffer`
// global at all for everything below — the `createStreamApi` build and the whole
// streaming round-trip. The pre-fix polyfill used `Buffer.from` / `Buffer.concat`,
// so the first `pull` would throw `Buffer is not defined` right here.
delete globalThis.Buffer
if (typeof globalThis.Buffer !== 'undefined') {
  throw new Error('probe setup failed: Buffer global is still defined')
}

// Pass the two native stream fns as `undefined`, forcing `createStreamApi` down
// the buffered class-API polyfill — the exact path a wasm/browser build takes, and
// the only path that touches the helper code under test.
const { compressStream, decompressStream } = createStreamApi({
  nativeCompressStream: undefined,
  nativeDecompressStream: undefined,
  Compressor: binding.XzCompressor,
  Decompressor: binding.XzDecompressor,
})

const original = new TextEncoder().encode('buffer-free polyfill round-trip 🚀 '.repeat(1000))

const fromChunks = (chunks) => {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
  })
}

const collect = async (stream) => {
  const reader = stream.getReader()
  const parts = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.length) {
      const copy = new Uint8Array(value)
      parts.push(copy)
      total += copy.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const chunk = (u8, size) => {
  const chunks = []
  for (let o = 0; o < u8.length; o += size) {
    chunks.push(u8.subarray(o, Math.min(o + size, u8.length)))
  }
  return chunks
}

const compressed = await collect(compressStream(fromChunks(chunk(original, 64))))
const restored = await collect(decompressStream(fromChunks(chunk(compressed, 7))))

if (restored.length !== original.length) {
  throw new Error(`round-trip length mismatch: ${restored.length} != ${original.length}`)
}
for (let i = 0; i < original.length; i++) {
  if (restored[i] !== original[i]) {
    throw new Error(`round-trip byte mismatch at index ${i}`)
  }
}

// Prove nothing silently re-introduced the global during the run.
if (typeof globalThis.Buffer !== 'undefined') {
  throw new Error('Buffer global unexpectedly present after the round-trip')
}

console.log('BUFFER_FREE_PROBE_OK')
