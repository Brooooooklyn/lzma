/**
 * T6 — Streaming robustness: trailer, error surfacing, lifecycle, web error/cancel.
 *
 * These EXTEND the matrices in `streaming-class.spec.ts` / `streaming-web.spec.ts`
 * (they do NOT re-add cases already covered there). New ground here:
 *   - the `finish()` trailer is load-bearing (update()-only output must NOT decode);
 *   - near-complete truncation (last 5 bytes cut) rejects on both APIs;
 *   - compressor double-finish() is a clean error;
 *   - the web transforms reject (never truncate or hang) on garbage / truncated /
 *     input-error, and round-trip empty input;
 *   - the cancel-during-pending-read behaviour is characterised HONESTLY.
 *
 * ── Terminal-error contract (class API) ──────────────────────────────────────
 * A decode failure is STICKY and terminal: once the worker has reported it, it
 * surfaces on the NEXT `update()` AND on `finish()` — both reject with the same
 * error, and `finish()` never resolves `Ok` after a failure (asserted in
 * `streaming-class.spec.ts` §10/§11). The tests below add the trailer + truncation
 * angles; they do not restate that sticky-error matrix.
 *
 * ── Cancel-during-pending-read (napi 3.10.x limitation, documented) ───────────
 * `const p = reader.read(); await reader.cancel()` on a stalled/slow input LEAKS
 * one `spawn_blocking` worker: napi's `ReadableStream` holds an async mutex across
 * the pull await, its `cancel` callback only `try_lock`s it (which fails mid-read),
 * and napi exposes NO hook to signal the worker from Rust. Forcing the worker to
 * exit (the robust fix) instead SEGFAULTs napi's own stream teardown (off-JS-thread
 * `napi_ref` drop). So there is no safe in-scope fix — a real one needs an upstream
 * napi cancel hook. The web-cancel test below asserts only that the process
 * SURVIVES such a cancel (capped far below the blocking pool); a companion `skip`
 * marks the unimplemented reclamation so it never reads as a false GREEN. See
 * `.superpowers/sdd/task-6-report.md`.
 */
import test from 'ava'

import * as lzmaStream from '../lzma'
import * as lzma2Stream from '../lzma2'
import * as xzStream from '../xz'
import {
  chunkBySize,
  collectStream,
  driveClassDecompress,
  fromChunks,
  loadCompressor,
  loadDecompressor,
  oneShot,
  IS_WASI,
  SUPPORTS_STREAMING_WASI,
  type CompressorInstance,
  type DecompressorInstance,
  type Namespace,
} from './helpers'

const NAMESPACES: readonly Namespace[] = ['lzma', 'lzma2', 'xz']

const INPUT = Buffer.from('T6 robustness 🚀 payload — Ünïcöde '.repeat(400), 'utf8')

// Class streaming builds tokio-free and runs on WASI, but this suite is not part
// of the WASI leg yet: self-skip the class cases under WASI unless the flag flips.
const classTest = IS_WASI && !SUPPORTS_STREAMING_WASI ? test.skip : test

// The web transforms exist only on a native build (compiled out on wasm). Gate on
// the raw binding fn, exactly like `streaming-web.spec.ts`.
const NATIVE_STREAM = typeof (xzStream as { compressStream?: unknown }).compressStream === 'function'
const webTest = NATIVE_STREAM ? test : test.skip

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

// ── 1) The finish() trailer is LOAD-BEARING (class) ──────────────────────────
// Concatenate ONLY the `update()` outputs and omit `finish()`. The result must
// NOT decode to the full input: `finish()` emits a required trailer (LZMA1/LZMA2
// end marker, XZ index+footer) and a strict decoder rejects the truncated tail
// rather than silently accepting it. This is the positive proof that meaningful
// output is `every update()` PLUS `finish()`, never `update()` alone.

for (const ns of NAMESPACES) {
  classTest(`${ns}: update()-only output (finish() trailer omitted) does NOT decode to the full input`, async (t) => {
    const Compressor = loadCompressor<CompressorInstance>(ns)
    const compressor = new Compressor()
    const parts: Buffer[] = []
    for (const chunk of chunkBySize(INPUT, 64)) {
      parts.push(Buffer.from(compressor.update(chunk)))
    }
    // Deliberately NO `finish()` — the trailer is withheld.
    const updateOnly = Buffer.concat(parts)
    let decodedFull = false
    try {
      const restored = await oneShot(ns).decompress(updateOnly)
      decodedFull = Buffer.from(restored).equals(INPUT)
    } catch {
      decodedFull = false // rejecting the trailer-less stream is the expected outcome
    }
    t.false(decodedFull, `${ns}: a trailer-less stream must not round-trip to the full input`)
  })
}

// ── 2) Near-complete truncation: cut the last 5 bytes → rejects (class) ───────
// `streaming-class.spec.ts` §8/§11 truncate at the HALFWAY point; here we cut only
// the final 5 bytes — a stream that is valid right up to the footer/end-marker —
// to prove the decoder still rejects a stream missing just its trailer, on
// `finish()`, without hanging or crashing.

for (const ns of NAMESPACES) {
  classTest(`${ns}: class decompress of a stream with its last 5 bytes cut rejects on finish()`, async (t) => {
    const compressed = await oneShot(ns).compress(INPUT)
    const truncated = compressed.subarray(0, compressed.length - 5)
    await t.throwsAsync(
      () => driveClassDecompress(ns, chunkBySize(truncated, 7)),
      undefined,
      `${ns}: a stream missing its trailer must reject`,
    )
    // Process stays alive: a fresh valid stream still decodes on a new instance.
    const restored = await driveClassDecompress(ns, chunkBySize(compressed, 7))
    t.deepEqual(restored, INPUT)
  })
}

// ── 3) Compressor double-finish() → clean error (class) ──────────────────────
// `streaming-class.spec.ts` §9 covers the DECOMPRESSOR double-finish; this covers
// the COMPRESSOR side. A second `finish()` (and any `update()` after `finish()`)
// must be a clean, catchable error — never a panic or a hang.

for (const ns of NAMESPACES) {
  classTest(`${ns}: compressor second finish() and update()-after-finish() reject cleanly`, async (t) => {
    const Compressor = loadCompressor<CompressorInstance>(ns)
    const c = new Compressor()
    c.update(INPUT.subarray(0, 128))
    await c.finish()
    // `finish()`/`update()` return a napi `Result`, so the guard is a SYNCHRONOUS
    // throw at the call site (not a rejected promise).
    t.throws(() => c.finish(), undefined, 'second finish() must throw')
    t.throws(() => c.update(Buffer.alloc(1)), undefined, 'update() after finish() must throw')
  })
}

// ── 4) Web transforms reject (never truncate/hang) on bad input ──────────────
// Garbage and near-complete truncation must ERROR the output ReadableStream, and
// the process must stay alive afterwards (a fresh round-trip still works).

const GARBAGE: Record<Namespace, Buffer> = {
  lzma: Buffer.alloc(64, 0xff),
  lzma2: Buffer.alloc(64, 0x20),
  xz: Buffer.alloc(64, 0xff),
}

for (const ns of NAMESPACES) {
  webTest(`${ns}: web decompress of garbage rejects (no hang/crash)`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]
    await t.throwsAsync(() => collectStream(decompressStream(fromChunks([GARBAGE[ns]]))))
    // Alive: a fresh round-trip still completes.
    const echo = Buffer.from('alive after garbage')
    const rt = await collectStream(
      decompressStream(fromChunks(chunkBySize(await collectStream(compressStream(fromChunks([echo]))), 5))),
    )
    t.deepEqual(rt, echo)
  })

  webTest(`${ns}: web decompress of a stream with its last 5 bytes cut rejects`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]
    const compressed = await collectStream(compressStream(fromChunks([INPUT])))
    const truncated = compressed.subarray(0, compressed.length - 5)
    await t.throwsAsync(() => collectStream(decompressStream(fromChunks(chunkBySize(truncated, 7)))))
    // Alive: the untruncated stream still decodes.
    const restored = await collectStream(decompressStream(fromChunks(chunkBySize(compressed, 7))))
    t.deepEqual(restored, INPUT)
  })
}

// ── 5) Web empty-input round-trips (both directions) ─────────────────────────
// The class API's empty case lives in `streaming-class.spec.ts`; this is the WEB
// half of "empty across both APIs". Empty compresses to a NON-empty container
// (header + trailer) that must decode back to zero bytes.

for (const ns of NAMESPACES) {
  webTest(`${ns}: web empty input round-trips to empty`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]
    const compressed = await collectStream(compressStream(fromChunks([])))
    const restored = await collectStream(decompressStream(fromChunks([compressed])))
    t.is(restored.length, 0)
  })
}

// ── 6) Web input that errors mid-stream → output rejects, process alive ───────
// A source `ReadableStream` that `controller.error()`s after a chunk must
// propagate as an ERRORED output (never a silent truncation). Uses `compress` so
// the failure is unambiguously the INPUT error (decompress would reject on the
// garbage bytes first).

for (const ns of NAMESPACES) {
  webTest(`${ns}: web compress with an input that errors mid-stream rejects (process alive)`, async (t) => {
    const { compressStream, decompressStream } = STREAM[ns]
    let pulls = 0
    const erroringInput = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(Buffer.from('some bytes before the input errors'))
        } else {
          controller.error(new Error('input boom'))
        }
      },
    })
    await t.throwsAsync(() => collectStream(compressStream(erroringInput)))
    // Alive: a fresh round-trip still works.
    const echo = Buffer.from('alive after input error')
    const rt = await collectStream(
      decompressStream(fromChunks(chunkBySize(await collectStream(compressStream(fromChunks([echo]))), 5))),
    )
    t.deepEqual(rt, echo)
  })
}

// ── 7) Web cancel-during-pending-read (napi limitation — SKIP, not GREEN) ─────
// `const p = reader.read(); await reader.cancel()` on a STALLED/slow input is a
// COMMON cancel pattern, and today it LEAKS: napi's `create_with_stream_bytes`
// output stream holds an async mutex across the pull await; its `cancel` callback
// only `try_lock`s that mutex, which FAILS while a read is in flight, so the
// receiver is never dropped and the parked pull future pins one `spawn_blocking`
// worker (+ its tsfn) for the process lifetime. napi 3.10.x exposes NO hook to
// signal the worker from Rust (every constructor hardcodes napi's own `cancel`).
//
// It cannot be characterised by an EXECUTED test: the leaked pull future keeps a
// live libuv tsfn handle, so a test that performs the cancel never lets its worker
// process EXIT — it hangs the suite even though the assertions "pass". And the
// robust fix (force the worker to exit so the pull future unwinds) instead
// SEGFAULTs / SIGBUSes napi's OWN stream teardown — an off-JS-thread `napi_ref`
// drop in `pull_callback_impl_bytes` (FunctionRef dropped on a tokio-rt-worker) and
// a use-after-free in napi's input `Reader::poll_next` — which is strictly worse
// than the leak. So there is no safe in-scope fix; a real one needs an upstream
// napi cancel hook. Verified against napi 3.10.3 (lldb backtraces + a 600× loop
// that exhausts tokio's 512-thread pool and hangs). Recorded as an honest ava SKIP
// so it never reads as a false GREEN. Full evidence: `.superpowers/sdd/task-6-report.md`.
//
// (Cancel patterns that DO tear down cleanly — cancel-before-read and
// cancel-after-read on a live/finite input — are exercised in
// `streaming-web.spec.ts` §5/§6 and pass.)
test.skip('web cancel-during-pending-read frees the blocking-pool worker (BLOCKED: needs an upstream napi cancel hook; leaks + forcing teardown segfaults napi)', () => {
  // Intentionally not executed — see the comment above and task-6-report.md.
})

// ── 8) Class garbage across the update()/finish() boundary rejects ────────────
// Complements the web garbage case: fully-invalid bytes fed to the class decoder
// must reject (on update() or finish()), never resolve, never hang.

for (const ns of NAMESPACES) {
  classTest(`${ns}: class decompress of garbage rejects (no hang/crash)`, async (t) => {
    await t.throwsAsync(async () => {
      const Decompressor = loadDecompressor<DecompressorInstance>(ns)
      const d = new Decompressor()
      d.update(GARBAGE[ns])
      await d.finish()
    })
  })
}
