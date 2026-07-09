<!-- Plan for https://github.com/Brooooooklyn/lzma/issues/372 — generated via multi-agent (ultracode) planning workflow, all facts source-verified against lzma-rust2 0.15.7 / napi-rs 3.10.3. Execute via the subagent-driven-development skill. -->

# @napi-rs/lzma — Streaming Support (issue #372): Executable Implementation Plan

## 1. Summary of end state

`@napi-rs/lzma` swaps its compression backend from `lzma-rs` to the pure-Rust `lzma-rust2` crate (single backend for everything) and gains streaming compress **and** decompress for all three formats (`lzma`, `lzma2`, `xz`). The existing six one-shot functions per namespace keep their exact signatures and behavior (guarded by the current liblzma-compat specs). Two new streaming surfaces ship per namespace: (1) a low-level portable `Compressor`/`Decompressor` `#[napi]` class with `update(chunk)`/`finish()` incremental methods (works on all 17 targets, threads only), and (2) a native-Rust Web Streams API `compressStream(ReadableStream)→ReadableStream` / `decompressStream(...)` (Node-native only, with a JS buffered polyfill on wasm). The wasm/exotic-target build stays in its currently-green configuration; tokio/`web_stream` are target-gated off wasm.

---

## 2. Architecture decisions

| # | Decision | Rationale |
|---|---|---|
| A1 | **Full backend swap** `lzma-rs` → `lzma-rust2 0.15`, single backend for one-shot + streaming. | Pure Rust, no build.rs/C → preserves the wasm/emnapi + musl/exotic matrix. Uniform push-`Write` encoders / pull-`Read` decoders across all 3 formats. |
| A2 | **One-shot** = drive the streaming types over in-memory `Vec`/`&[u8]`. Decoders read a full `&[u8]` and hit their logical end before any underflow → **no worker/adapter needed** for one-shot. | Simplest correct mapping; existing compat specs are the regression oracle. |
| A3 | **Class decompress pull-adapter = option (a): `std::thread` worker + bounded `sync_channel` blocking `Read`.** Inner `Read::read` blocks on `recv()` and returns `Ok(0)` **only** when the input sender is dropped (true EOF). | The lzma-rust2 decoders call `read_exact` internally and are **not** checkpoint-resumable (range decoder + LZ dict mutate mid-read), so a "return WouldBlock/Ok(0) and retry" adapter corrupts state. Blocking-until-more-input-or-close is exactly what `read_exact` needs. `std::thread` exists on all 17 targets (wasm target is `*-threads`). |
| A4 | **Class channels are BOUNDED** (`sync_channel(N)`, N≈8) in both directions. | Prevents an unbounded worker (esp. a decompression bomb) from buffering the whole expansion in RAM → real backpressure. `update()`/`finish()` output is meaningful only as the **concatenation** of all calls (per-call output is "bytes ready so far, possibly empty"). |
| A5 | **Web Streams = native Rust** `#[napi]` fns via `ReadableStream::create_with_stream_bytes`, CPU work on `spawn_blocking`, bridged by bounded tokio mpsc + a blocking `ChannelReader`/`ChannelWriter`. | Encoders are also CPU-heavy; symmetric `spawn_blocking` for both directions keeps the tokio worker unblocked. Types auto-generate into `index.d.ts`. |
| A6 | **wasm gating (Plan B2):** target-gate the napi `web_stream` feature + tokio deps to `cfg(not(target_family = "wasm"))`; `#[cfg(not(target_family="wasm"))]` the Rust stream fns; ship a **JS buffered polyfill** for `compressStream`/`decompressStream` on wasm. | On a current-thread wasm tokio runtime, fire-and-forget `spawn`/`spawn_blocking` tasks never advance without a `block_on` → the native stream would hang. Gating keeps wasm byte-for-byte in its validated config with **zero** tokio, zero `RUSTFLAGS` change. The **class** API (threads only, no tokio) remains available on wasm. |
| A7 | **lzma-rust2 `optimization` feature: KEEP ON globally.** | All asm/SIMD is `cfg`-gated to x86_64/aarch64 with scalar + big-endian fallbacks; `forbid(unsafe_code)` when off. One-line fallback = drop the feature or target-gate it to those two arches if any CI build breaks (verify in T0). |
| A8 | **Method naming: `update()` + `finish()`.** Options passed as a **single options object** everywhere. | `write()` collides with Node `Writable.write()` (returns a boolean, no data) — a footgun. `update()`/`finish()` matches Node's incremental-codec idiom (`Hash.update`/`digest`). Object options (`{ preset }`, `{ dictSize }`) avoid the positional-meaning trap and are forward-compatible. |
| A9 | **Both `Compressor.finish()` and `Decompressor.finish()` return `Promise<Buffer>`**; both `update()` return `Buffer` (sync). | Uniform shape across the two classes; a generic pipe helper treats both directions identically. Compressor `finish()` resolves immediately (trivial cost); decompressor `finish()` joins the worker off the JS thread via `AsyncTask`. |
| A10 | **lzma2 dict-size contract (resolves the blocker): pin the lzma2 dictionary to a shared canonical `LZMA2_DICT_SIZE = 8 MiB` on BOTH encode and decode**, regardless of preset. | Raw LZMA2 carries no in-band dict size; `Lzma2Reader::new` takes it as a ctor arg. `LzmaOptions.dict_size` is a public field, so the lzma2 encoder pins dict to 8 MiB (preset still drives lc/lp/pb/mf) while decode uses the same 8 MiB → back-refs can never exceed the decode window. `.lzma` (header-borne dict) and `xz` (block header) are immune and need no pinning. Optional symmetric `dictSize` override exposed on both lzma2 classes/fns for advanced callers (must match). |

### Final `Cargo.toml`

```toml
[dependencies]
lzma-rust2  = { version = "0.15", default-features = false, features = ["std", "encoder", "xz", "optimization"] }
napi        = "3"          # DEFAULT features (napi4 + dyn-symbols) — unchanged on wasm
napi-derive = "3"

# Native (non-wasm) only: pulls tokio_rt + tokio + napi4 for the Web Streams API.
[target.'cfg(not(target_family = "wasm"))'.dependencies]
napi         = { version = "3", features = ["web_stream"] }   # cargo unions with the base line
tokio        = { version = "1", features = ["sync"] }         # tokio::sync::mpsc; runtime comes from napi
tokio-stream = { version = "0.1", features = ["sync"] }       # wrappers::ReceiverStream (napi's own is default-featured)

# lzma-rs line REMOVED. mimalloc target blocks + [profile.release] + [build-dependencies] UNCHANGED.
```

Notes: `Cargo.lock` is git-ignored (regenerates). Repo stays edition 2024; lzma-rust2 is edition 2021 / MSRV 1.82 (no conflict). Transitive `crc`+`sha2` are pure Rust (no build.rs). Use **one** tokio instance — import channel types from `napi::tokio::sync::mpsc` so `ReceiverStream` (from the directly-added `tokio-stream` with `sync`) wraps the same `Receiver`; verify with `cargo tree` in T4 that only one `tokio 1.x` resolves.

---

## 3. Tasks (dependency-ordered, TDD)

> **Hard gate:** every streaming task depends on **T0**. T0 introduces the `lzma-rust2` dependency the classes/streams compile against **and** the one-shot `compress`/`decompress` functions that serve as the round-trip **oracle** for streaming tests. Do **not** stub T0. After T0, T2/T3/T4 can proceed in parallel (T1 naming spike gates the public identifiers first).

---

### Task 0 (T0) — Backend swap + shared `backend.rs` + one-shot rewrite (HARD GATE)

**Files:** `Cargo.toml`, `src/lib.rs`, **new** `src/backend.rs`, **new** `__test__/lzma2.spec.ts`, extend `__test__/lzma.spec.ts` & `__test__/xz.spec.ts`.

**Change:**
1. Apply the `Cargo.toml` swap above (base deps only for this task; the target-gated block can land here too but the stream module arrives in T4).
2. New `src/backend.rs` — the **single source of truth** for format wiring, shared by one-shot, class, and stream layers:
   ```rust
   pub const LZMA2_DICT_SIZE: u32 = 8 << 20; // canonical, matches lzma-rust2 DICT_SIZE_DEFAULT
   pub const DEFAULT_PRESET: u32 = 6;

   pub fn lzma_writer<W: Write>(w: W, preset: u32) -> Result<LzmaWriter<W>> {
       LzmaWriter::new_use_header(w, &LzmaOptions::with_preset(preset), None) // header + end-marker, unknown size
   }
   pub fn lzma_reader<R: Read>(r: R) -> Result<LzmaReader<R>> {
       LzmaReader::new_mem_limit(r, u32::MAX, None) // reads dict+size from the 13-byte .lzma header
   }
   pub fn lzma2_writer<W: Write>(w: W, preset: u32, dict_size: Option<u32>) -> Lzma2Writer<W> {
       let mut opts = Lzma2Options::with_preset(preset);
       opts.lzma_options.dict_size = dict_size.unwrap_or(LZMA2_DICT_SIZE); // PIN dict (A10)
       Lzma2Writer::new(w, opts)
   }
   pub fn lzma2_reader<R: Read>(r: R, dict_size: Option<u32>) -> Lzma2Reader<R> {
       Lzma2Reader::new(r, dict_size.unwrap_or(LZMA2_DICT_SIZE), None)
   }
   pub fn xz_writer<W: Write>(w: W, preset: u32) -> Result<XzWriter<W>> {
       XzWriter::new(w, XzOptions::with_preset(preset)) // default check = CRC64
   }
   pub fn xz_reader<R: Read>(r: R) -> Result<XzReader<R>> { Ok(XzReader::new(r, true)) }
   // + map_io / map_invalid error helpers (io::Error -> napi Error; decode failures -> Status::InvalidArg)
   ```
3. Rewrite the `define_functions!` macro bodies in `src/lib.rs` so `compress*/decompress*` drive these constructors over a `Vec<u8>` sink / `&[u8]` source (`write_all` + `finish()` for encode; `read_to_end` for decode). Keep `Either<String,Uint8Array>` input, optional `AbortSignal`, `AsyncTask`/`ScopedTask`, zero-copy `BufferSlice`, mimalloc attrs, `#![deny(clippy::all)]` — all byte-identical to today. `grep -rn 'lzma_rs\|lzma-rs' src Cargo.toml` must return nothing.

**RED tests (define done):**
- **New** `__test__/lzma2.spec.ts`: async + sync round-trip of `'Hello 🚀'` and cross (async-out decoded by sync). This closes the pre-existing lzma2 coverage gap.
- **Extend** `lzma.spec.ts` + `xz.spec.ts` with round-trip **and** `lzma-native` cross-compat cases (degrade to self round-trip when `lzma-native` is absent, mirroring the existing `try/catch` loader) covering: **empty input**, `>2 MB` (crosses the LZMA2 2 MiB uncompressed-chunk boundary), `>8 MB` (dict-window wrap), incompressible random bytes, highly-repetitive bytes. Assert **round-trip / C-decode**, never byte-identity (valid across the backend change).
- **New** lzma2 preset-9 test: compress `>8 MB` of low-entropy (long-back-reference) data at the **max** lzma2 preset, assert correct round-trip (proves A10 dict-pin).

**Acceptance:** `yarn build` + `cargo clippy` (deny-clean) + `cargo fmt --check` + `taplo format --check` clean; all of `lzma.spec.ts`, `xz.spec.ts`, `lzma2.spec.ts` green; `git diff --exit-code index.d.ts` unchanged; `lzma-rs` absent from `cargo tree`. Run `cargo check --target wasm32-wasip1-threads` and `--target s390x-unknown-linux-gnu` with `optimization` on — if either fails, drop `optimization` (or target-gate it to x86_64/aarch64) and record the winning feature set.

---

### Task 1 (T1) — Namespace-class-name spike (gate public identifiers)

**Files:** throwaway `#[napi]` classes (reverted after), records a decision.

**Change:** Register two throwaway classes with identical `js_name = "Compressor"` in namespaces `a`/`b`; `napi build`; inspect generated `index.d.ts` + a `require()` smoke call.

**Acceptance (decision recorded before any spec identifier is frozen):** If namespaced classes generate cleanly → public names are `xz.Compressor` / `lzma.Compressor` / `lzma2.Compressor` (+ `Decompressor`). If they flatten/collide → fall back to top-level `XzCompressor` / `LzmaCompressor` / `Lzma2Compressor` consistently. **Write the resolved names into `__test__/helpers.ts`** (the single import site for all specs). Revert the throwaway code.

---

### Task 2 (T2) — `Compressor` classes (xz / lzma / lzma2)

**Files:** **new** `src/stream.rs`, `src/lib.rs` (`mod stream;` + macro invocation per namespace), **new** `__test__/helpers.ts`, **new** `__test__/streaming-class.spec.ts` (compress half).

**Change:** A `SharedSink(Vec<u8>): io::Write`. Per-namespace macro-generated `Compressor` holding `Option<XzWriter<SharedSink>>` etc., built via `backend::*_writer`:
```rust
#[napi] pub fn update(&mut self, env: &Env, chunk: Uint8Array) -> Result<BufferSlice> {
    let w = self.w.as_mut().ok_or_else(finished)?;
    w.write_all(chunk.as_ref()).map_err(map_io)?;      // MUST NOT call flush()/set_flushing (A-invariant)
    let out = std::mem::take(&mut w.inner_mut().0);    // drain only already-produced bytes
    BufferSlice::from_data(env, out)
}
#[napi] pub async fn finish(&mut self, env: &Env) -> Result<BufferSlice> { // returns Promise<Buffer>
    let w = self.w.take().ok_or_else(finished)?;
    BufferSlice::from_data(env, w.finish().map_err(map_io)?.0)   // emits the format trailer
}
```
Constructor takes an options object `{ preset?: number }`; lzma2 also `{ dictSize?: number }`. **Hard implementation constraint:** `update()` must never call the writer's `flush()`/`set_flushing()` (that forces a chunk boundary and breaks byte-identity, esp. LZMA2) — code-review checkpoint.

`helpers.ts` provides fixtures + the **only** place that knows method names: `driveClassCompress(ns, chunks, opts)` = loop `await c.update(ch)` then `await c.finish()`, concat.

**RED tests — oracle is the T0 one-shot decompress (so this half-task is independently verifiable):**
- For each format: `driveClassCompress` over `['Hello 🚀'.repeat(500)]` in 1-byte, 64-byte, single, and awkward (empty+1-byte) chunkings → `await ns.decompress(result)` equals input.
- **Byte-identity invariant:** compressor output is byte-identical across all chunkings vs the single-chunk reference (`got.equals(ref)`).
- **Empty input:** zero `update()` calls then `finish()` → decodes back to empty.
- Non-wasi + `lzma-native` present: for xz and lzma, `lzma-native` strictly decodes the class output (validates the trailer/footer/end-marker is present and correct).

**Acceptance:** all compress round-trips + byte-identity + empty pass for all 3 formats; `cargo clippy` clean; no `unsafe`.

---

### Task 3 (T3) — `Decompressor` classes (xz / lzma / lzma2)

**Files:** `src/stream.rs` (add), `src/lib.rs`, `__test__/streaming-class.spec.ts` (decompress half).

**Change:** `ChannelReader { rx: Receiver<Vec<u8>>, cur, pos }: io::Read` that **blocks on `recv()`** and returns `Ok(0)` only when the sender drops. Per-namespace `Decompressor`:
- Constructor: **bounded** `sync_channel(8)` in + out; spawn the worker with `std::thread::Builder::new().spawn(...)` (map spawn `Err` → napi error, **never** an implicit `panic!`/abort). Worker builds the reader **inside** the thread (so the eager header read blocks on the channel) via `backend::*_reader`, loops `read()` into a 64 KiB buf, sends `Ok(chunk)`/`Err(msg)` on the bounded out channel.
- lzma2 constructor takes `{ dictSize?: number }` (default `LZMA2_DICT_SIZE`); xz/lzma take `{}`.
- `update(chunk)` (sync `Buffer`): `in_tx.send(chunk.to_vec())` (blocks if worker is behind → backpressure), then non-blocking `try_recv` drain of ready output. Returns "bytes so far, possibly empty".
- `finish()` (`Promise<Buffer>` via `AsyncTask`): drop `in_tx` (→ EOF), then on the libuv pool block on `recv()` draining the tail, `join()` the worker, surface any worker `Err`. Idempotent-guarded with `take()`.
- `Drop`: dropping `in_tx` makes the worker EOF and exit — no hung thread if GC'd without `finish()`.

**RED tests — oracle is T0 one-shot compress:**
- For each format: `await ns.compress(input)` → split into tiny chunks → `driveClassDecompress` → equals input. Include a `5 MB` fixture (proves incremental worker output while JS feeds).
- lzma2 `dictSize` case + the preset-9 `>8 MB` case decoded via the class.
- Round-trip through `driveClassCompress → driveClassDecompress` across chunkings.
- **Backpressure/bomb:** decompress a highly-compressible large payload; assert round-trip completes within ava's 2 min timeout without OOM (bounded channel keeps memory bounded).

**Acceptance:** all decode round-trips pass for all 3 formats (native + musl); `finish()` on the garbage/truncated cases **rejects** (T6 owns those assertions but the plumbing must not hang/crash); GC-without-finish leaves no hung thread; `cargo clippy` clean.

---

### Task 4 (T4) — Web Streams API (native Rust + wasm polyfill + gating)

**Files:** **new** `src/stream/backend.rs` (or extend `src/stream.rs`), **new** `src/stream/mod.rs`, `src/lib.rs` (`#[cfg(not(target_family="wasm"))] mod stream_web;`), `Cargo.toml` target-gated block (if not already in T0), `xz.js`/`lzma.js`/`lzma2.js` (native-or-polyfill export), **new** `__test__/streaming-web.spec.ts`.

**Change:** `ChannelReader`/`ChannelWriter` over `napi::tokio::sync::mpsc` bounded channels (`CAP=16`); 6 runner fns reusing `backend::*_writer/reader`. Generic `spawn_pipeline`:
```rust
fn spawn_pipeline<F>(env: &Env, input: ReadableStream<Uint8Array>, worker: F)
  -> Result<ReadableStream<BufferSlice>>
  where F: FnOnce(Receiver<Chunk>, Sender<Chunk>) + Send + 'static {
    let mut reader = input.read()?;                    // owned 'static Send Reader — consume before spawn
    let (in_tx, in_rx) = channel(CAP); let (out_tx, out_rx) = channel(CAP);
    spawn(async move { while let Some(i)=reader.next().await { if in_tx.send(i.map(|u|u.to_vec())).await.is_err(){break} } });
    spawn_blocking(move || worker(in_rx, out_tx));
    ReadableStream::create_with_stream_bytes(env, ReceiverStream::new(out_rx))
}
#[napi(namespace="xz")] pub fn compress_stream(env:&Env, input:ReadableStream<Uint8Array>, options:Option<CompressOpts>) -> Result<ReadableStream<BufferSlice>> {...}
#[napi(namespace="xz")] pub fn decompress_stream(env:&Env, input:ReadableStream<Uint8Array>, options:Option<DecompressOpts>) -> Result<ReadableStream<BufferSlice>> {...}
```
lzma2 stream fns thread `dictSize` into `backend::lzma2_writer/reader`. Cancellation is automatic (consumer cancels → `out_rx` drops → `blocking_send` errors → worker breaks → `in_rx` drops → pump errors → `reader` drops).

**JS wiring** — extend each per-namespace entry file with a native-or-polyfill export (so `index.d.ts` advertises the fns on all targets while wasm gets a buffered fallback):
```js
module.exports.compressStream = xz.compressStream ?? ((input, options) =>
  new ReadableStream({ async pull(c){ if(!this.d){ this.d=1; c.enqueue(await xz.compress(await bufferAll(input), options?.preset)); c.close() } } }))
// decompressStream analogous via xz.decompress
```

**RED tests (`streaming-web.spec.ts`, WASI-skipped — `create_with_stream_bytes` chunks are SharedArrayBuffer-backed which `controller.enqueue` rejects under emnapi):**
- For each format: `compressStream(fromChunks(...))` collected → `decompressStream(...)` collected → equals input (multi-chunk).
- Web-stream output ⇄ class output ⇄ one-shot interop (all three agree).
- Backpressure smoke: `10 MB` random input round-trips within timeout.
- xz/lzma: cross-check `decompressStream` against `lzma-native`-produced streams.

**Acceptance:** native + musl round-trips green; `napi build` regenerates `index.d.ts` with the 6 stream fns; WASI run skips web-stream specs with a message; `cargo tree` shows a single `tokio 1.x`; `napi build --target wasm32-wasip1-threads` compiles (stream module cfg'd out).

---

### Task 5 (T5) — JS entry wiring + packaging + convenience factories

**Files:** `xz.js`/`lzma.js`/`lzma2.js` (+ `.d.ts` if hand-maintained — should stay pure re-exports since types auto-generate), `package.json` (`files[]`, `exports`), **new** packaging smoke test, optional `#[napi]` doc attrs.

**Change:**
1. Export the classes (`Compressor`/`Decompressor`) and stream fns from each per-namespace file. Per-namespace `*.d.ts` remain **pure re-exports of `index.d.ts`** (no hand-authored stream types — A5 makes them auto-generated), so napi keeps them in sync.
2. `package.json`: add an explicit `types` condition to each subpath export (`./xz`, `./lzma`, `./lzma2`) pointing at the sibling `.d.ts`; ensure any new entry file is in `files[]` **and** `exports` **and** ships a `.d.ts`.
3. Ship one convenience factory per direction/format returning a ready-to-pipe Node `Transform` over the Web Streams fns via `Readable.fromWeb/toWeb` (e.g. `xz.createCompressStream(opts)`), so the common `createReadStream().pipe(...)` case is one call. Add `#[napi]` doc attrs noting `compressStream` needs a WHATWG `ReadableStream` (wrap raw `Readable` with `Readable.toWeb()`).
4. `Compressor.update()` accepts `string | Uint8Array` (UTF-8 encode) to match the one-shot `string` convention.

**RED/acceptance:** a packaging smoke test (import from built paths + `arethetypeswrong`-style check, or `tsc` typecheck of a consumer importing `@napi-rs/lzma/xz`) confirms the streaming surface is reachable **and** typed from the published shape (not just relative `../xz` imports); `tsc` typechecks all specs against the regenerated `.d.ts`.

---

### Task 6 (T6) — Robustness, error surfacing, trailer, cancel

**Files:** **new** `__test__/streaming-robustness.spec.ts`, `__test__/streaming-cross-compat.spec.ts`.

**RED tests (all formats, class + web; class-decode WASI cases gated by `SUPPORTS_STREAMING_WASI`):**
- **Trailer is load-bearing:** concat only the `update()` outputs (omit `finish()`); assert it does **not** decode to the full input (proves the decoder doesn't silently accept a truncated tail and that `finish()` emits a required trailer).
- **Strict-decoder validation:** `lzma-native`/liblzma decodes the full class/web xz + lzma output (footer/end-marker present).
- Garbage input → `finish()` **rejects** (no hang/crash). Truncated stream (cut last 5 bytes) → rejects.
- `finish()` called twice → clean error, not panic/hang.
- Cross-compat: stream-compress → one-shot decompress; one-shot compress → stream-decompress; C-compress → stream-decompress; stream-compress → C-decompress (xz/lzma).
- **Empty** across both APIs.
- Web-stream error/cancel: input `ReadableStream` that `c.error()`s mid-stream → output rejects, process stays alive; early `reader.cancel()` on output tears down without hang.
- Document (and assert via tests) that terminal decoder errors surface on the **next** `update()` or on `finish()` — `finish()` always reports a pending worker error even if the input channel already closed.

**Acceptance:** all robustness + cross-compat assertions green on native/musl; WASI runs the class cases (or self-skips if the flag is flipped) and skips web-stream cases.

---

### Task 7 (T7) — wasm/WASI parity + large/big-endian + CI

**Files:** `.github/workflows/CI.yml` (only if needed), test wiring, `package.json` (optional wasm target-alias normalization).

**Change / acceptance:**
- `NAPI_RS_FORCE_WASI=1 yarn test`: one-shot + **class** streaming round-trips pass (threads+channels work under emnapi); web-stream specs self-skip (SAB). Add a **wasm concurrency test** — many simultaneous `Decompressor`s — to confirm the async-work-pool isn't starved; if it fails, set `SUPPORTS_STREAMING_WASI=false` in `helpers.ts` (class-decode WASI cases self-skip; native/musl/qemu still cover them) and steer wasm decompress users to one-shot/polyfill. This is a coordination flag, **not** a silent skip.
- Multi-MB (4 MB) xz + lzma + lzma2 round-trips run inside the per-target `test-*-binding` jobs (not just host) so **s390x/ppc64le (big-endian, `continue-on-error`)** actually exercise CRC64 + endian paths. Keep fixtures ≤4 MB to stay under the 2 min ava timeout in QEMU.
- No CI YAML change required for the recommended plan (napi default features on wasm, tokio target-gated off). Confirm s390x/ppc64le remain `continue-on-error`.

---

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **tokio on wasm hangs the native stream** (current-thread rt never polls fire-and-forget tasks). | A6: `web_stream`/tokio target-gated off wasm; stream fns `cfg`-gated out; JS buffered polyfill. Verified `napi build --target wasm32-wasip1-threads` compiles (T4/T7). |
| **lzma2 dict undersize → silent corruption at preset ≥7.** | A10: pin encode+decode dict to shared `LZMA2_DICT_SIZE` (8 MiB); preset-9 `>8 MB` long-back-ref round-trip test (T0) proves it. |
| **Deadlock / false EOF in the pull-adapter.** | A3: blocking `recv()` `Read` returns `Ok(0)` only on sender drop; reader built inside the worker so the eager header read blocks on the channel. Truncated/garbage tests (T6) assert reject-not-hang. |
| **Unbounded memory (decompression bomb).** | A4: bounded `sync_channel` (class) + bounded tokio mpsc CAP=16 (web) → real backpressure; bomb test in T3. |
| **wasm async-pool starvation from parked `finish()` AsyncTasks + parked worker threads.** | T7 concurrency test + `SUPPORTS_STREAMING_WASI` flag fallback; `thread::Builder::spawn` maps spawn failure to a catchable napi error (no `panic=abort`). |
| **Class-name collision across namespaces.** | T1 spike gates the public identifiers before any spec freezes them; fallback `XzCompressor`-style names in one `helpers.ts` import site. |
| **Byte-identity broken by a stray `flush()`.** | Hard impl constraint + code-review checkpoint (T2): `update()` only `write_all` + drain `inner_mut()`; never `flush()`/`set_flushing()`. |
| **`optimization` breaks an exotic target.** | T0 smoke-checks wasm + s390x; fallback = drop the feature or target-gate to x86_64/aarch64 (100% safe Rust). |
| **`.lzma` streaming compress emits most output at `finish()`.** | Expected (range coder batches). Tests assert only concatenated totals, never per-chunk sizes; C-compat leg proves the end-marker `.lzma` stays decodable. |
| **Two tokio instances.** | Import channels from `napi::tokio::*`; `cargo tree` single-`tokio` assertion (T4). |

---

## 5. Verification commands

```bash
# Build (native) + regenerate index.d.ts / *.wasi glue
yarn build                              # napi build --platform --release
cargo clippy --all-targets              # #![deny(clippy::all)] must be clean
cargo fmt --check && taplo format --check && npx oxlint

# Tests (native)
yarn test                               # ava, auto-discovers __test__/*.spec.ts

# WASI path (class streaming + one-shot; web-stream specs self-skip)
NAPI_RS_FORCE_WASI=1 yarn test

# Cross-compile smoke (feature/opt de-risk)
cargo check --target wasm32-wasip1-threads
cargo check --target s390x-unknown-linux-gnu
napi build --target wasm32-wasip1-threads   # regenerates lzma.wasi*.{cjs,js}, wasi-worker*.mjs

# Backend fully removed
grep -rn 'lzma_rs\|lzma-rs' src Cargo.toml   # must be empty
cargo tree | grep -c '^tokio v1'             # must be 1
git diff --exit-code index.d.ts              # after T0: unchanged
```
Do **not** hand-edit generated files (`index.d.ts`, `lzma.d.ts`, `lzma2.d.ts`, `xz.d.ts`, `lzma.wasi*.cjs/js`, `wasi-worker*.mjs`) — regenerate via `napi build`. Watch the wasi `initial` memory pages if large-dict streaming with extra worker threads needs headroom (runtime, not build, concern).

---

## 6. Backward compatibility & versioning

- **The six existing functions per namespace (`compress`, `compressSync`, `decompress`, `decompressSync`) keep byte-identical JS signatures, `Either<String,Uint8Array>` input, optional `AbortSignal`, `AsyncTask` + zero-copy `BufferSlice` output, and mimalloc setup.** They are re-implemented on `lzma-rust2` but produce standard liblzma-decodable `.lzma`/`.xz` (preset 6: `.lzma` props `0x5D`, 8 MiB dict; xz CRC64) and adapt to any foreign preset on decode via header parsing. The existing `lzma.spec.ts`/`xz.spec.ts` are the unmodified regression oracle. `index.d.ts` for these six is unchanged (`git diff --exit-code` in T0). This is a **backward-compatible** change for existing consumers.
- **New surface is purely additive:** `Compressor`/`Decompressor` classes and `compressStream`/`decompressStream` (+ `createCompressStream`/`createDecompressStream` factories) per namespace.
- **Version bump: minor** (e.g. `x.(y+1).0`) — new features, no breaking API change. If the internal backend swap is considered risky enough to flag, still minor (behavior of public one-shot API is preserved).
- **Changelog:** (1) "Swapped compression backend from `lzma-rs` to pure-Rust `lzma-rust2`; one-shot API behavior unchanged, output remains standard liblzma-compatible." (2) "Added streaming compress/decompress for lzma, lzma2, xz via incremental `Compressor`/`Decompressor` classes (all platforms) and a native Web Streams API `compressStream`/`decompressStream` (Node-native; wasm falls back to a buffered polyfill)." (3) Note: raw lzma2 streams use a fixed 8 MiB dictionary (override via `{ dictSize }` on both ends); true incremental streaming is native-only, wasm uses buffered one-shot; Web Streams input must be a WHATWG `ReadableStream` (wrap Node `Readable` with `Readable.toWeb()`).
