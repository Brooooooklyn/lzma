/**
 * Web Streams API (T4) — the native tokio-backed `compressStream` /
 * `decompressStream` transforms.
 *
 * These specs drive the NATIVE transforms, so they run only where those fns
 * exist on the raw binding (`index.js`). Under WASI the tokio-backed fns are
 * compiled out and the per-namespace entry files fall back to a buffered
 * polyfill; that polyfill's `create_with_stream_bytes` equivalent is not what
 * runs here, and the native-output chunks are SharedArrayBuffer-backed under
 * emnapi (which `controller.enqueue` rejects), so the whole suite is registered
 * as a genuine ava SKIP when the native fn is absent — never a silent pass.
 */
import { createRequire } from 'node:module'

import test from 'ava'

import * as lzmaStream from '../lzma'
import * as lzma2Stream from '../lzma2'
import * as xzStream from '../xz'
import {
  chunkBySize,
  collectStream,
  deterministicBytes,
  driveClassCompress,
  driveClassDecompress,
  fromChunks,
  lowEntropyBytes,
  oneShot,
  type Namespace,
} from './helpers'

// Bare `require` is undefined under the ESM test loader (@oxc-node); bind one to
// this file to detect the native fn and optionally load the `lzma-native` oracle.
const requireFrom = createRequire(import.meta.url)

const IS_WASI = !!process.env.NAPI_RS_FORCE_WASI

/** The raw native binding — presence of the native stream fn is the skip gate. */
const binding = requireFrom('../index.js') as { xz?: { compressStream?: unknown } }
const NATIVE_STREAM = typeof binding.xz?.compressStream === 'function'

// Native present → run; native absent (WASI / a stream-less build) → SKIP.
const webTest = NATIVE_STREAM ? test : test.skip

const NAMESPACES: readonly Namespace[] = ['lzma', 'lzma2', 'xz']

type StreamFn = (input: ReadableStream<Uint8Array>, options?: unknown) => ReadableStream<Uint8Array>
interface StreamApi {
  compressStream: StreamFn
  decompressStream: StreamFn
}

const STREAM: Record<Namespace, StreamApi> = {
  lzma: lzmaStream as unknown as StreamApi,
  lzma2: lzma2Stream as unknown as StreamApi,
  xz: xzStream as unknown as StreamApi,
}

const INPUT = Buffer.from('Web Streams 🚀 lzma transform '.repeat(2000), 'utf8')

// ── 1) Multi-chunk round-trip per format ─────────────────────────────────────
// compressStream(fromChunks(...)) → collect → decompressStream(fromChunks(...))
// → collect must equal the input, with BOTH halves fragmented at awkward,
// independent byte boundaries (64 in, 7 out) so no boundary alignment is assumed.

for (const ns of NAMESPACES) {
  webTest(`${ns}: compressStream → decompressStream round-trips (multi-chunk)`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]
    const compressed = await collectStream(compressStream(fromChunks(chunkBySize(INPUT, 64))))
    const restored = await collectStream(decompressStream(fromChunks(chunkBySize(compressed, 7))))
    t.deepEqual(restored, INPUT)
  })
}

// ── 2) Web-stream ⇄ class ⇄ one-shot interop (all three agree) ───────────────
// The streaming transform, the incremental class, and the one-shot fn share the
// same backend encoder and never flush per chunk, so their compressed output is
// BYTE-IDENTICAL. We assert that, then cross-decode each producer's output with
// every other consumer so the three surfaces are proven fully interoperable.

for (const ns of NAMESPACES) {
  webTest(`${ns}: web-stream, class, and one-shot outputs agree and interoperate`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]

    const webCompressed = await collectStream(compressStream(fromChunks(chunkBySize(INPUT, 128))))
    const classCompressed = await driveClassCompress(ns, chunkBySize(INPUT, 128))
    const oneShotCompressed = Buffer.from(await oneShot(ns).compress(INPUT))

    // All three producers must emit the identical byte stream.
    t.true(webCompressed.equals(classCompressed), `${ns}: web output diverged from class output`)
    t.true(webCompressed.equals(oneShotCompressed), `${ns}: web output diverged from one-shot output`)

    // Cross-decode: every producer's output decodes through every other consumer.
    t.deepEqual(Buffer.from(await oneShot(ns).decompress(webCompressed)), INPUT, 'web → one-shot decode')
    t.deepEqual(await driveClassDecompress(ns, chunkBySize(webCompressed, 5)), INPUT, 'web → class decode')
    t.deepEqual(
      await collectStream(decompressStream(fromChunks(chunkBySize(classCompressed, 5)))),
      INPUT,
      'class → web decode',
    )
    t.deepEqual(
      await collectStream(decompressStream(fromChunks(chunkBySize(oneShotCompressed, 5)))),
      INPUT,
      'one-shot → web decode',
    )
  })
}

// ── 3) Backpressure smoke: 10 MB random round-trips within timeout ───────────
// Random (incompressible) 10 MB fed in 64 KiB input chunks and re-split into
// 4 KiB compressed chunks. The bounded (CHANNEL_CAP) channels fill and drain
// repeatedly; a stalled pump/worker/consumer chain would hang until ava's 2 min
// timeout instead of completing.

const TEN_MB = deterministicBytes(10 * 1024 * 1024)

for (const ns of NAMESPACES) {
  webTest(`${ns}: 10 MB random round-trips through the transforms (backpressure)`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]
    const compressed = await collectStream(compressStream(fromChunks(chunkBySize(TEN_MB, 64 * 1024))))
    const restored = await collectStream(decompressStream(fromChunks(chunkBySize(compressed, 4096))))
    t.true(restored.equals(TEN_MB), `${ns}: 10 MB round-trip mismatch`)
  })
}

// ── 4) Cross-check decompressStream against an lzma-native-produced stream ────
// Encode with the independent C implementation (lzma-native), decode through our
// transform. Registered as a genuine ava SKIP when lzma-native cannot load
// (WASI, or a prebuild-less arch) — never a hard failure on those legit targets.

type NativeEncode = (buf: Buffer) => Promise<Buffer>
const nativeEncode: Partial<Record<'xz' | 'lzma', NativeEncode>> = {}
let lzmaNativeAvailable = false

if (NATIVE_STREAM && !IS_WASI) {
  try {
    const lzmaNative = requireFrom('lzma-native')
    // Default `compress` emits `.xz`.
    nativeEncode.xz = (buf) =>
      new Promise((resolve) => {
        lzmaNative.compress(buf, 6, (result: Buffer) => resolve(Buffer.from(result)))
      })
    // The `LZMA()` engine emits the `.lzma` (alone) container our lzma reader wants.
    nativeEncode.lzma = (buf) => {
      const engine = lzmaNative.LZMA()
      return new Promise((resolve) => {
        engine.compress(buf, 6, (result: Buffer) => resolve(Buffer.from(result)))
      })
    }
    lzmaNativeAvailable = true
  } catch {
    // lzma-native unavailable here; the cross-check legs skip below.
  }
}

const crossTest = NATIVE_STREAM && lzmaNativeAvailable ? test : test.skip

for (const ns of ['xz', 'lzma'] as const) {
  crossTest(`${ns}: decompressStream decodes an lzma-native-produced stream`, async (t) => {
    const encode = nativeEncode[ns]!
    const compressed = await encode(INPUT)
    const restored = await collectStream(STREAM[ns].decompressStream(fromChunks(chunkBySize(compressed, 9))))
    t.deepEqual(restored, INPUT)
  })
}

// ── 5) Cancellation smoke: cancel the reader early, runtime stays healthy ─────
// Start a decompressStream, pull one chunk, then cancel the output reader. The
// cancel must unwind the whole chain (out_rx drop → worker blocking_send errors
// → worker exits → in_rx drop → pump breaks → input Reader drops) leaving NO
// hung blocking thread and NO unhandled rejection. We then run a fresh
// round-trip to prove the tokio runtime is still healthy (a leaked/parked worker
// would eventually starve it).

webTest('cancellation: cancelling the output reader leaves the runtime healthy', async (t) => {
  const { compressStream, decompressStream } = STREAM.xz
  const big = lowEntropyBytes(4 * 1024 * 1024)
  const compressed = await collectStream(compressStream(fromChunks([big])))

  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  t.teardown(() => process.off('unhandledRejection', onRejection))

  const out = decompressStream(fromChunks(chunkBySize(compressed, 3)))
  const reader = out.getReader()
  await reader.read() // pull one chunk while the worker is running
  await reader.cancel() // cancel early
  await new Promise((resolve) => setTimeout(resolve, 250))

  // Fresh round-trip: proves no deadlock / hung thread starved the runtime.
  const echo = Buffer.from('still alive after cancel')
  const roundTrip = await collectStream(
    decompressStream(fromChunks(chunkBySize(await collectStream(compressStream(fromChunks([echo]))), 5))),
  )
  t.deepEqual(roundTrip, echo)
  t.deepEqual(rejections, [], 'no unhandled rejection after cancelling the reader')
})

// ── 6) Thread-leak guard: input-starved cancel must not leak the blocking pool ─
// The previously-leaking window: cancel the OUTPUT while the worker is INPUT-
// STARVED (parked in `blocking_recv`, having neither sent nor EOF'd) and the pump
// is parked in `reader.next()` on a never-settling input. Cancelling WITHOUT ever
// reading the output means no output pull is issued (the native byte stream's
// HWM is 0), so the cancel drops `out_rx` immediately — yet a worker parked on
// the input side only ever learns of a dropped `out_rx` via its NEXT
// `blocking_send`, which it never makes. Without wiring output-cancel back to the
// input side, each such cancel leaks one parked `spawn_blocking` worker; looping
// it past tokio's default 512-thread blocking pool exhausts the pool, so a later
// `spawn_blocking` (the health-check round-trip) can never run and hangs. With the
// fix the pump `select!`s the input read against `out_tx.closed()`, so a dropped
// `out_rx` breaks the pump, drops `in_tx`, and frees the worker — the loop is
// cheap and the round-trip completes promptly. This is the deterministic RED/GREEN
// signal: reverting just the `select!` regresses it into a hang.

webTest('cancellation: input-starved output cancel does not leak the blocking pool', async (t) => {
  const { compressStream, decompressStream } = STREAM.xz

  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  t.teardown(() => process.off('unhandledRejection', onRejection))

  // `pull()` never settles → the transform's input channel is permanently starved,
  // so the spawn_blocking worker parks in `blocking_recv` (never sends, never EOFs).
  const stalledInput = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    })

  // Exceed the 512-thread default blocking pool so a per-cancel worker leak
  // provably exhausts it. Alternate compress/decompress so BOTH workers (each of
  // which parks in `blocking_recv` when input-starved) are exercised.
  const LEAK_ATTEMPTS = 600
  for (let i = 0; i < LEAK_ATTEMPTS; i++) {
    const transform = i % 2 === 0 ? decompressStream : compressStream
    const reader = transform(stalledInput()).getReader()
    await reader.cancel() // cancel WITHOUT reading: worker is input-starved, out_rx drops now
    // Periodically yield so the runtime can drain freed workers (fix path): keeps
    // the healthy case from transiently approaching the pool cap under release lag.
    if (i % 50 === 49) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  // Health-check: a fresh, independent round-trip must complete promptly. An
  // exhausted pool would queue its spawn_blocking forever; the timeout turns that
  // into a fast, deterministic failure instead of a 2-min ava timeout.
  const echo = Buffer.from('healthy after 600 input-starved cancels')
  let timer: ReturnType<typeof setTimeout> | undefined
  const health = (async () => {
    const compressed = await collectStream(compressStream(fromChunks([echo])))
    return collectStream(decompressStream(fromChunks(chunkBySize(compressed, 5))))
  })()
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error('runtime starved: health-check round-trip did not complete — blocking pool exhausted by leaked workers'),
        ),
      30_000,
    )
  })
  try {
    const roundTrip = await Promise.race([health, guard])
    t.deepEqual(roundTrip, echo)
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
  t.deepEqual(rejections, [], 'no unhandled rejection after input-starved cancels')
})
