//! Incremental (streaming) `#[napi]` compressor classes for the three formats.
//!
//! Each class holds one live encoder over a heap-only [`SharedSink`] and exposes
//! the `update()` / `finish()` incremental pair (plan A8):
//!
//! * [`update`](LzmaCompressor::update) is **synchronous**. It writes the chunk
//!   into the encoder and drains whatever bytes the encoder has produced so far
//!   (possibly none) as a zero-copy `BufferSlice`. It MUST NEVER flush the
//!   encoder — a flush forces a chunk boundary and would make the output depend
//!   on how the input was split, breaking the byte-identity invariant the tests
//!   assert (most visibly for LZMA2). Meaningful output is only the
//!   concatenation of every `update()` plus the `finish()` tail (A4).
//! * `finish()` returns a `Promise<Buffer>` (A9). It moves the owned encoder
//!   onto the libuv pool via [`AsyncTask`] (NOT a tokio `async fn`, which would
//!   pull `napi/tokio_rt`; the class API must build for every target — wasm
//!   included — on default napi features), flushes it, and emits the format
//!   trailer. A double-finish is guarded by `Option::take`, so a second call
//!   rejects cleanly instead of panicking.
//!
//! The classes are registered at the crate top level with distinct JS names
//! (`LzmaCompressor` / `Lzma2Compressor` / `XzCompressor`) rather than a shared
//! namespaced `Compressor` name — the T1 spike proved namespaced same-named
//! classes break `.d.ts` codegen (see `__test__/helpers.ts`).

use std::io::{self, Read, Write};
use std::sync::mpsc::{Receiver, Sender, SyncSender};
use std::thread::JoinHandle;

use lzma_rust2::{Lzma2Writer, LzmaWriter};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::backend::{self, DEFAULT_PRESET, XzEncoder, map_invalid, map_io};

/// A `Send`, heap-only sink the streaming encoders drain incrementally.
///
/// It is a plain `Vec<u8>` — deliberately NO `Rc`/`RefCell`/`Cell`: `finish()`
/// moves the encoder (and therefore this sink) onto a worker thread, so every
/// field must be `Send`. `update()` drains the produced bytes with
/// `std::mem::take`, leaving an empty `Vec` for the encoder to keep appending to.
#[derive(Default)]
pub struct SharedSink(Vec<u8>);

impl Write for SharedSink {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    self.0.extend_from_slice(buf);
    Ok(buf.len())
  }

  fn flush(&mut self) -> io::Result<()> {
    Ok(())
  }
}

/// Builds the "already finished" rejection used by both the double-finish guard
/// and the (unreachable in practice) second `finish` task poll. A clean napi
/// error, never a panic.
fn already_finished() -> napi::Error {
  napi::Error::new(
    napi::Status::InvalidArg,
    "compressor already finished".to_owned(),
  )
}

/// Off-thread finish: flush the encoder and emit its format trailer on the libuv
/// pool, so the JS thread never blocks on the tail. This keeps the
/// `finish() -> Promise<Buffer>` shape uniform with the decompressor (A9) while
/// using only threads (no tokio), so it works on all 17 targets.
///
/// The owned encoder is captured in a `Send` boxed closure; every format's
/// `finish(self)` yields `io::Result<SharedSink>`, so one closure type serves
/// all three classes without an oversized enum.
pub struct CompressorFinish(Option<Box<dyn FnOnce() -> io::Result<Vec<u8>> + Send>>);

#[napi]
impl Task for CompressorFinish {
  type Output = Vec<u8>;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    let finish = self.0.take().ok_or_else(already_finished)?;
    finish().map_err(map_io)
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(Buffer::from(output))
  }
}

/// Options for the LZMA1 and XZ streaming compressors.
#[napi(object)]
#[derive(Default)]
pub struct CompressorOptions {
  /// Compression preset `0..=9` (default 6). Higher = smaller output, slower.
  pub preset: Option<f64>,
}

/// Options for the LZMA2 streaming compressor: adds an explicit dictionary size
/// because raw LZMA2 carries none in-band, so encoder and decoder must agree.
#[napi(object)]
#[derive(Default)]
pub struct Lzma2CompressorOptions {
  /// Compression preset `0..=9` (default 6).
  pub preset: Option<f64>,
  /// Dictionary size in bytes (defaults to 8 MiB, [`backend::LZMA2_DICT_SIZE`]).
  pub dict_size: Option<f64>,
}

/// Generates a top-level `#[napi]` streaming compressor class.
///
/// `$drain` is the encoder's sink accessor (`inner_mut` for the lzma-rust2
/// writers, `sink_mut` for [`XzEncoder`]); `$build` VALIDATES the
/// user-controlled options, then constructs the encoder over a fresh
/// [`SharedSink`], yielding a napi `Result<$writer>`. Validation happens inside
/// `$build` (mapping bad input to `InvalidArg`) so an out-of-range preset / dict
/// size can NEVER reach the allocating, infallible native writer and panic or
/// OOM the process — the constructor rejects it first.
macro_rules! define_compressor {
  (
    doc: $doc:literal,
    $class:ident,
    options: $options:ty,
    writer: $writer:ty,
    drain: $drain:ident,
    build: |$opts:ident| $build:expr $(,)?
  ) => {
    #[doc = $doc]
    #[napi]
    pub struct $class {
      /// `None` once `finish()` has consumed the encoder (double-finish guard).
      inner: Option<$writer>,
    }

    #[napi]
    impl $class {
      /// Create a streaming compressor. `options` is optional; an absent or
      /// empty object uses [`DEFAULT_PRESET`].
      ///
      /// The `preset` (and, for LZMA2, `dictSize`) are validated before the
      /// native encoder is built, so out-of-range input rejects with an
      /// `InvalidArg` error instead of panicking or OOM-ing the process.
      #[napi(constructor)]
      pub fn new(options: Option<$options>) -> Result<Self> {
        let $opts = options.unwrap_or_default();
        let inner: Result<$writer> = $build;
        Ok(Self {
          inner: Some(inner?),
        })
      }

      /// Feed one chunk. A `string` is UTF-8 encoded (matching the one-shot
      /// `compress` convention); a `Uint8Array` is fed verbatim. Returns the
      /// bytes produced so far (possibly empty) as a zero-copy view; only the
      /// concatenation of every `update()` + `finish()` is a valid stream. Never
      /// flushes the encoder (byte-identity invariant).
      #[napi]
      pub fn update<'env>(
        &mut self,
        env: &'env Env,
        chunk: Either<String, Uint8Array>,
      ) -> Result<BufferSlice<'env>> {
        let writer = self.inner.as_mut().ok_or_else(already_finished)?;
        // A string compresses its UTF-8 bytes; a Uint8Array its raw bytes. Both
        // borrow, so no extra copy beyond what `write_all` consumes.
        let bytes: &[u8] = match &chunk {
          Either::A(text) => text.as_bytes(),
          Either::B(buf) => buf.as_ref(),
        };
        writer.write_all(bytes).map_err(map_io)?;
        let produced = std::mem::take(&mut writer.$drain().0);
        BufferSlice::from_data(env, produced)
      }

      /// Flush the encoder and emit the format trailer off the JS thread.
      /// Resolves to the tail bytes. Idempotency-guarded: a second call rejects.
      #[napi]
      pub fn finish(&mut self) -> Result<AsyncTask<CompressorFinish>> {
        let writer = self.inner.take().ok_or_else(already_finished)?;
        Ok(AsyncTask::new(CompressorFinish(Some(Box::new(
          move || Ok(writer.finish()?.0),
        )))))
      }
    }
  };
}

define_compressor! {
  doc: "Incremental `.lzma` (LZMA1) compressor: 13-byte header + end marker.",
  LzmaCompressor,
  options: CompressorOptions,
  writer: LzmaWriter<SharedSink>,
  drain: inner_mut,
  build: |opts| {
    let preset = opts
      .preset
      .map(|value| backend::coerce_u32_index(value, "preset").and_then(backend::validate_preset))
      .transpose()
      .map_err(map_invalid)?
      .unwrap_or(DEFAULT_PRESET);
    backend::lzma_writer(SharedSink::default(), preset).map_err(map_io)
  },
}

define_compressor! {
  doc: "Incremental raw LZMA2 compressor (dictionary pinned out of band, A10).",
  Lzma2Compressor,
  options: Lzma2CompressorOptions,
  writer: Lzma2Writer<SharedSink>,
  drain: inner_mut,
  build: |opts| {
    let preset = opts
      .preset
      .map(|value| backend::coerce_u32_index(value, "preset").and_then(backend::validate_preset))
      .transpose()
      .map_err(map_invalid)?
      .unwrap_or(DEFAULT_PRESET);
    // `None` keeps the pinned `LZMA2_DICT_SIZE` default (A10); an explicit value
    // is range-checked so it can never panic/OOM the infallible `Lzma2Writer`.
    let dict_size = opts
      .dict_size
      .map(|value| backend::coerce_u32_index(value, "dictSize").and_then(backend::validate_dict_size))
      .transpose()
      .map_err(map_invalid)?;
    Ok(backend::lzma2_writer(SharedSink::default(), preset, dict_size))
  },
}

define_compressor! {
  doc: "Incremental `.xz` compressor (empty-input-safe via the shared `XzEncoder`).",
  XzCompressor,
  options: CompressorOptions,
  writer: XzEncoder<SharedSink>,
  drain: sink_mut,
  build: |opts| {
    let preset = opts
      .preset
      .map(|value| backend::coerce_u32_index(value, "preset").and_then(backend::validate_preset))
      .transpose()
      .map_err(map_invalid)?
      .unwrap_or(DEFAULT_PRESET);
    XzEncoder::new(SharedSink::default(), preset).map_err(map_io)
  },
}

// ===========================================================================
// Streaming decompressors (T3).
// ===========================================================================
//
// lzma-rust2's DECODERS are pull-based (`impl io::Read`) — the mirror image of
// the push-based encoders above. A streaming `update(chunk)` API is push, so
// each decompressor runs its decoder on a dedicated worker thread that PULLS
// compressed bytes from a channel ([`ChannelReader`]) and PUSHES the decoded
// bytes back over a second channel.
//
// Channel-direction asymmetry (the crux of the deadlock-freedom):
//
// * The OUT channel (worker -> JS) is BOUNDED (`sync_channel(OUT_CHANNEL_BOUND)`).
//   The worker blocks on `out_tx.send` once it is full, so a decompression bomb
//   (a tiny compressed input expanding to gigabytes) can NEVER run the worker
//   more than `OUT_CHANNEL_BOUND * 64 KiB` ahead of what JS has drained — memory
//   stays bounded (A4). This is where bomb backpressure lives.
//
// * The IN channel (JS -> worker) is UNBOUNDED, and `update()` hands off its
//   chunk with a NON-BLOCKING send. This is deliberate and load-bearing:
//   `update()` is a SYNCHRONOUS napi method running on the main JS thread, so it
//   must NEVER block — a blocking send/recv there freezes the whole libuv event
//   loop. A bounded in-channel with a blocking "if in is full, recv from out"
//   driver DEADLOCKS in practice: a decoder buffers decoded bytes internally
//   until its 64 KiB read buffer fills or it hits the end marker, so for any
//   stream whose total output is < 64 KiB (fed in tiny chunks) the worker
//   consumes ALL input while producing ZERO output, then parks on the in-channel
//   — while `update`, having filled the in-channel, parks on `out_rx.recv()`
//   waiting for output that never comes. Making the in-channel unbounded removes
//   both the freeze and the deadlock; input backlog is bounded anyway by the
//   caller-provided compressed size, not by bomb expansion.

/// Bound (in messages) of the decoded-OUT channel — the decompression-bomb
/// backpressure knob. Each out message is `<= 64 KiB`, so the worker can run at
/// most ~`OUT_CHANNEL_BOUND * 64 KiB` ahead of the JS consumer. (The in-channel
/// is intentionally unbounded; see the module comment.)
const OUT_CHANNEL_BOUND: usize = 8;

/// A worker -> JS message: either a decoded chunk or a stringified decode error.
/// `String` (not `io::Error`) so it is `Send` and cheap to move across the
/// channel; the driver re-wraps it as a napi error.
type WorkerMsg = std::result::Result<Vec<u8>, String>;

/// Blocking, buffer-FILLING [`io::Read`] adapter that pulls compressed chunks
/// off the input channel. It lives INSIDE the worker thread and is what makes the
/// decoder's eager header read block until JS feeds the first `update()`.
///
/// It fills `buf` COMPLETELY, blocking on `recv()` for as many chunks as needed,
/// and returns a short read (possibly `Ok(0)`) ONLY at true EOF — i.e. once the
/// sender has been dropped (`recv()` -> `RecvError`; the JS side dropped `in_tx`
/// in `finish()`/`Drop`) and no buffered bytes remain. This "read fully or EOF"
/// contract is load-bearing:
///
/// * `lzma_rust2`'s `XzReader` reads its block padding / magic / framing with
///   plain `read()` and treats a short read as corruption
///   (`"incomplete XZ block padding"`), assuming — as a slice reader would
///   guarantee — that `read()` fills the buffer. A chunk-boundary-respecting
///   reader that returned partial reads would spuriously fail those checks, so we
///   must never split a requested read across a chunk boundary except at EOF.
/// * A merely empty-so-far state must NEVER surface as `Ok(0)`, or the decoder
///   would mistake a mid-stream lull for EOF and fail its `read_exact` of the
///   header/trailer.
///
/// Empty chunks (from empty `update()` calls) are transparently skipped.
struct ChannelReader {
  rx: Receiver<Vec<u8>>,
  cur: Vec<u8>,
  pos: usize,
}

impl ChannelReader {
  fn new(rx: Receiver<Vec<u8>>) -> Self {
    Self {
      rx,
      cur: Vec::new(),
      pos: 0,
    }
  }
}

impl Read for ChannelReader {
  fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
    let mut written = 0;
    while written < buf.len() {
      if self.pos >= self.cur.len() {
        // Current chunk drained; block for the next. A dropped sender is the
        // only true EOF — return however much we have gathered (a short read,
        // possibly 0), never a false EOF mid-stream.
        match self.rx.recv() {
          Ok(chunk) => {
            self.cur = chunk;
            self.pos = 0;
            continue; // chunk may be empty; the loop re-checks and blocks again
          }
          Err(_) => break,
        }
      }
      let n = std::cmp::min(buf.len() - written, self.cur.len() - self.pos);
      buf[written..written + n].copy_from_slice(&self.cur[self.pos..self.pos + n]);
      self.pos += n;
      written += n;
    }
    Ok(written)
  }
}

/// Worker loop: pump decoded bytes onto the out channel until EOF (`Ok(0)`), a
/// decode error, or the consumer dropping the out receiver.
fn pump_reader<R: Read>(mut reader: R, out_tx: &SyncSender<WorkerMsg>) {
  let mut buf = [0u8; 64 * 1024];
  loop {
    match reader.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => {
        // `send` blocks when the out channel is full — this is the
        // backpressure that bounds memory under a decompression bomb. A send
        // error means the consumer went away (Drop); just exit.
        if out_tx.send(Ok(buf[..n].to_vec())).is_err() {
          break;
        }
      }
      Err(e) => {
        let _ = out_tx.send(Err(e.to_string()));
        break;
      }
    }
  }
}

/// Re-wrap a worker decode-error reason as the napi error the JS side sees. A
/// worker error is always a decode failure (the [`ChannelReader`] never yields an
/// `io::Error`), i.e. malformed input, so it maps to `InvalidArg` — matching the
/// one-shot decode path. The reason is a `Send` `String`, so the SAME terminal
/// error can be re-wrapped and surfaced more than once (by both `update()` and
/// `finish()`), which is what makes the failure sticky.
fn decode_error(reason: String) -> napi::Error {
  napi::Error::new(napi::Status::InvalidArg, reason)
}

/// The double-finish / use-after-finish guard error (a clean napi error, never a
/// panic).
fn already_finished_decompressor() -> napi::Error {
  napi::Error::new(
    napi::Status::InvalidArg,
    "decompressor already finished".to_owned(),
  )
}

/// The live channels + worker handle backing one decompressor. Every field is
/// `Send`, so the whole struct can move onto the libuv pool in `finish()`.
struct DecompressorState {
  /// Unbounded so the synchronous `update()` never blocks the JS thread (see the
  /// module comment). `Sender`, not `SyncSender`.
  in_tx: Sender<Vec<u8>>,
  out_rx: Receiver<WorkerMsg>,
  /// STICKY terminal decode error. The FIRST worker error a drain observes is
  /// recorded here (its `Send` reason `String`) so EVERY later `update()` /
  /// `finish()` rejects with the same error. Without it, an error surfaced by
  /// `update()` would be consumed once and a later `finish()` — draining an
  /// already-empty channel from an exited worker — would falsely resolve `Ok`,
  /// a false success after the stream had already failed.
  failed: Option<String>,
  /// `Some` until [`into_finish`](DecompressorState::into_finish) joins it.
  /// Dropped (detached) if the class is GC'd without `finish()`: the worker then
  /// EOFs on the dropped `in_tx` (and unparks from any `out_tx.send` when
  /// `out_rx` drops), so it exits on its own — no hung thread, no join needed.
  worker: Option<JoinHandle<()>>,
}

impl DecompressorState {
  /// Create the channels (unbounded in, bounded out) and spawn the worker, which
  /// builds its pull-reader INSIDE the thread (so the eager header read blocks on
  /// the channel) via `make_reader`. Spawn failure maps to a napi error — never a
  /// panic/abort on a no-thread target.
  fn spawn<R, F>(thread_name: &str, make_reader: F) -> Result<Self>
  where
    R: Read + 'static,
    F: FnOnce(ChannelReader) -> io::Result<R> + Send + 'static,
  {
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (out_tx, out_rx) = std::sync::mpsc::sync_channel::<WorkerMsg>(OUT_CHANNEL_BOUND);
    let worker = std::thread::Builder::new()
      .name(thread_name.to_owned())
      .spawn(move || match make_reader(ChannelReader::new(in_rx)) {
        Ok(reader) => pump_reader(reader, &out_tx),
        // A reader that fails to build (e.g. a malformed header the eager
        // construction rejects) reports the error, then the thread exits.
        Err(e) => {
          let _ = out_tx.send(Err(e.to_string()));
        }
      })
      .map_err(|e| {
        napi::Error::from_reason(format!("failed to spawn {thread_name} worker thread: {e}"))
      })?;
    Ok(Self {
      in_tx,
      out_rx,
      failed: None,
      worker: Some(worker),
    })
  }

  /// Non-blocking drain of the OUT channel into `out`. On the FIRST worker error,
  /// record its reason as the [sticky](DecompressorState::failed) terminal
  /// failure BEFORE returning the napi error, so every later `update()` /
  /// `finish()` surfaces the same failure and no more input is pushed to the dead
  /// worker. Shared by both `update_bytes` drain passes (keeps them DRY).
  fn drain_available(&mut self, out: &mut Vec<u8>) -> Result<()> {
    while let Ok(msg) = self.out_rx.try_recv() {
      match msg {
        Ok(bytes) => out.extend(bytes),
        Err(reason) => {
          self.failed = Some(reason.clone());
          return Err(decode_error(reason));
        }
      }
    }
    Ok(())
  }

  /// Feed one chunk and return every decoded byte available so far (possibly
  /// empty).
  ///
  /// FULLY NON-BLOCKING, so it can never freeze the JS event loop or deadlock:
  /// the chunk is handed to the unbounded in-channel with a non-blocking `send`,
  /// and the out-channel is drained with `try_recv`. Bomb backpressure is NOT
  /// here — it is on the bounded out-channel, where the worker parks on
  /// `out_tx.send`; each `update()`/`finish()` drains that channel so the worker
  /// can only ever run a bounded distance ahead. A decode error the worker has
  /// already reported is surfaced eagerly by the drain and recorded as the
  /// [sticky](DecompressorState::failed) terminal failure, so it is fail-fast
  /// (rejects immediately, pushing no more input) on every later call.
  fn update_bytes(&mut self, chunk: &[u8]) -> Result<Vec<u8>> {
    // Fail fast: once the decoder has terminally failed, reject with the recorded
    // reason and push NOTHING more to the (already exited) worker.
    if let Some(reason) = &self.failed {
      return Err(decode_error(reason.clone()));
    }
    let mut out = Vec::new();
    // Drain whatever the worker produced so far (also surfaces + records a decode
    // error as sticky).
    self.drain_available(&mut out)?;
    // Hand the chunk off without blocking. A send error means the worker already
    // exited (clean EOF or an error it already pushed onto the out channel);
    // that is not fatal here — the trailing output/error is drained above and in
    // `finish()`, so the extra input is simply ignored.
    let _ = self.in_tx.send(chunk.to_vec());
    // Drain again: the handoff may have unblocked a worker parked on a full out
    // channel, and earlier input may have just now produced output.
    self.drain_available(&mut out)?;
    Ok(out)
  }

  /// Off the JS thread: signal EOF (drop `in_tx`), drain the decoded tail, join
  /// the worker, and surface any worker error. Consumes `self`.
  fn into_finish(mut self) -> Result<Vec<u8>> {
    // A terminal decode error already observed (and recorded) by `update()`:
    // still tear the worker down cleanly (drop `in_tx`, join), but REJECT —
    // `finish()` must never resolve `Ok` once the stream has failed. The worker
    // reported the error before exiting normally, so its `join()` cannot be a
    // panic here; the recorded reason takes precedence.
    if let Some(reason) = self.failed.take() {
      drop(self.in_tx);
      if let Some(handle) = self.worker.take() {
        let _ = handle.join();
      }
      return Err(decode_error(reason));
    }
    // Dropping the sender is the EOF signal the ChannelReader turns into
    // `Ok(0)` for the decoder.
    drop(self.in_tx);
    let mut out = Vec::new();
    let mut decode_err = None;
    // `recv()` yields `Err(RecvError)` once the worker drops `out_tx` (it is
    // done), which ends the loop; a decode error breaks early.
    while let Ok(msg) = self.out_rx.recv() {
      match msg {
        Ok(bytes) => out.extend(bytes),
        Err(reason) => {
          decode_err = Some(decode_error(reason));
          break;
        }
      }
    }
    if let Some(handle) = self.worker.take() {
      // A panicked worker (join Err) must surface as an error, never abort the
      // process. On the normal path this returns immediately (the worker has
      // already exited).
      if handle.join().is_err() {
        return Err(napi::Error::from_reason(
          "decompressor worker thread panicked".to_owned(),
        ));
      }
    }
    match decode_err {
      Some(e) => Err(e),
      None => Ok(out),
    }
  }
}

/// Off-thread `finish()` for the decompressors: drains the decoded tail and
/// joins the worker on the libuv pool, mirroring [`CompressorFinish`].
/// `Option::take` makes a second poll / second `finish()` a clean napi error
/// instead of a panic.
pub struct DecompressorFinish(Option<DecompressorState>);

#[napi]
impl Task for DecompressorFinish {
  type Output = Vec<u8>;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    let state = self.0.take().ok_or_else(already_finished_decompressor)?;
    state.into_finish()
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(Buffer::from(output))
  }
}

/// Generates a top-level `#[napi]` streaming decompressor class. The `$ctor`
/// body validates any user options, then builds a [`DecompressorState`] via
/// [`DecompressorState::spawn`] and wraps it in `Ok(Self { .. })`. `update()`
/// and `finish()` are identical across formats, so only the constructor varies.
macro_rules! define_decompressor {
  (
    doc: $doc:literal,
    $class:ident,
    new( $($param:tt)* ) $ctor:block $(,)?
  ) => {
    #[doc = $doc]
    #[napi]
    pub struct $class {
      /// `None` once `finish()` has consumed the worker (idempotency guard).
      inner: Option<DecompressorState>,
    }

    #[napi]
    impl $class {
      /// Create a streaming decompressor and start its decoder worker thread.
      #[napi(constructor)]
      pub fn new( $($param)* ) -> Result<Self> $ctor

      /// Feed one compressed chunk; returns the bytes decoded so far (possibly
      /// empty) as a zero-copy view. Deadlock-free under backpressure. The valid
      /// output is the concatenation of every `update()` plus the `finish()`
      /// tail.
      #[napi]
      pub fn update<'env>(
        &mut self,
        env: &'env Env,
        chunk: Uint8Array,
      ) -> Result<BufferSlice<'env>> {
        let state = self.inner.as_mut().ok_or_else(already_finished_decompressor)?;
        let produced = state.update_bytes(chunk.as_ref())?;
        BufferSlice::from_data(env, produced)
      }

      /// Signal EOF and resolve to the decoded tail off the JS thread.
      /// Idempotency-guarded: a second call rejects cleanly.
      #[napi]
      pub fn finish(&mut self) -> Result<AsyncTask<DecompressorFinish>> {
        let state = self.inner.take().ok_or_else(already_finished_decompressor)?;
        Ok(AsyncTask::new(DecompressorFinish(Some(state))))
      }
    }
  };
}

/// Options for the LZMA2 streaming decompressor: it must be told the dictionary
/// size the stream was encoded with, because raw LZMA2 carries none in-band.
#[napi(object)]
#[derive(Default)]
pub struct Lzma2DecompressorOptions {
  /// Dictionary size in bytes (defaults to 8 MiB, [`backend::LZMA2_DICT_SIZE`],
  /// which MUST match the encoder's pinned default, A10).
  pub dict_size: Option<f64>,
}

define_decompressor! {
  doc: "Incremental `.lzma` (LZMA1) decompressor: reads dict/size from the header.",
  LzmaDecompressor,
  new() {
    let state = DecompressorState::spawn("lzma-decompressor", backend::lzma_reader)?;
    Ok(Self { inner: Some(state) })
  },
}

define_decompressor! {
  doc: "Incremental raw LZMA2 decompressor (dictionary pinned out of band, A10).",
  Lzma2Decompressor,
  new(options: Option<Lzma2DecompressorOptions>) {
    let opts = options.unwrap_or_default();
    // `None` keeps the pinned `LZMA2_DICT_SIZE` default (A10); an explicit value
    // is validated with the SAME infra as the encoder so a bad size is a clean
    // `InvalidArg` at construction, never a panic/OOM.
    let dict_size = opts
      .dict_size
      .map(|value| backend::coerce_u32_index(value, "dictSize").and_then(backend::validate_dict_size))
      .transpose()
      .map_err(map_invalid)?;
    let state = DecompressorState::spawn("lzma2-decompressor", move |src| {
      Ok(backend::lzma2_reader(src, dict_size))
    })?;
    Ok(Self { inner: Some(state) })
  },
}

define_decompressor! {
  doc: "Incremental `.xz` decompressor (supports concatenated `.xz` streams).",
  XzDecompressor,
  new() {
    let state = DecompressorState::spawn("xz-decompressor", backend::xz_reader)?;
    Ok(Self { inner: Some(state) })
  },
}
