//! Web Streams API (native, tokio-backed) transforms for the three formats.
//!
//! These `compress_stream` / `decompress_stream` functions accept a JS
//! `ReadableStream<Uint8Array>` and return a `ReadableStream<Buffer>`, so a
//! caller can pipe data through the codec without buffering the whole payload.
//!
//! This module is **target-gated to non-wasm** (`lib.rs` cfg's it out for
//! `target_family = "wasm"`): it is the only part of the crate that uses tokio
//! (via napi's `web_stream` feature — `napi::tokio` + `napi::tokio_stream`).
//! The wasm build has no tokio, so it drops these fns and the JS wrapper falls
//! back to a buffered polyfill built on the tokio-free class API. The class API
//! in `stream.rs` stays tokio-free precisely so it still builds on wasm.
//!
//! ## Pipeline (`spawn_pipeline`)
//!
//! Three independent tasks connected by two bounded (`CHANNEL_CAP`) channels,
//! so no single thread ever has to make progress on both ends at once (this is
//! what makes bounded-both deadlock-free, unlike the class decompressor which
//! must keep its JS-facing in-channel unbounded):
//!
//! ```text
//!   JS input ReadableStream
//!        │  reader.next().await          (async pump task, napi runtime)
//!        ▼
//!     in_tx ──[bounded CHANNEL_CAP]── in_rx
//!        │                                (worker, spawn_blocking thread)
//!        ▼  writer/reader over the shared backend
//!     out_tx ─[bounded CHANNEL_CAP]── out_rx
//!        │                                (create_with_stream_bytes pull)
//!        ▼
//!   JS output ReadableStream<Buffer>
//! ```
//!
//! ## Error propagation
//!
//! The channels carry [`Chunk`] = `napi::Result<Vec<u8>>`. On ANY worker failure
//! (a codec write/read error, or the input stream itself erroring) the worker
//! sends a single `Err(napi::Error)` item and stops. `create_with_stream_bytes`
//! turns that `Err` item into an ERRORED output `ReadableStream` rather than a
//! silently-truncated one — matching the class API's sticky-error behaviour.
//! Compression maps codec errors with [`backend::map_io`]; decompression maps
//! them with [`backend::map_invalid`] (`InvalidArg`, i.e. malformed input),
//! identical to the one-shot / class decode paths.
//!
//! ## Cancellation / EOF (no hung blocking thread)
//!
//! * **Consumer cancels** the output stream → `out_rx` drops → the worker's
//!   `blocking_send` errors → the worker breaks and returns → `in_rx` drops →
//!   the pump's `in_tx.send` errors → the pump breaks → the input `Reader`
//!   drops. No thread is left parked.
//! * **Normal EOF**: the input ends → the pump drops `in_tx` → the worker's
//!   `blocking_recv` returns `None` → the worker finishes/flushes the trailer →
//!   drops `out_tx` → the output stream closes.

use std::io::{self, Read, Write};

use lzma_rust2::{Lzma2Writer, LzmaWriter};
use napi::bindgen_prelude::*;
use napi::tokio::sync::mpsc::{Receiver, Sender, channel};
use napi::tokio_stream::StreamExt;
use napi::tokio_stream::wrappers::ReceiverStream;

use crate::backend::{self, XzEncoder};

/// Bound (in messages) of BOTH channels. Small, so at most a handful of chunks
/// sit in flight between the JS threads and the worker — this is the streaming
/// backpressure knob. Bounding both ends is safe here (unlike the class API)
/// because the pump, worker, and consumer are three separate tasks, so neither
/// end has to drain the other before it can make progress.
const CHANNEL_CAP: usize = 16;

/// A channel message: a decoded/encoded byte chunk, or a terminal error. Making
/// the item a `napi::Result` lets the worker forward a failure as an `Err` item
/// so the output `ReadableStream` ERRORS instead of truncating silently.
type Chunk = Result<Vec<u8>>;

/// Blocking, buffer-FILLING [`io::Read`] adapter that pulls compressed chunks off
/// the worker's in-channel (decompression side). Lives inside the `spawn_blocking`
/// worker, so `blocking_recv` is legal here (never on a runtime worker thread).
///
/// It fills `buf` COMPLETELY, blocking for as many chunks as needed, and returns
/// a short read (possibly `Ok(0)`) ONLY at true EOF — once the sender is dropped.
/// This "read fully or EOF" contract is load-bearing: `XzReader` reads its block
/// padding / framing with plain `read()` and treats a short read as corruption,
/// so a requested read must never be split across a chunk boundary except at EOF
/// (learned in the class-decompressor task). Empty chunks are skipped. An `Err`
/// item (the input stream errored) surfaces as an `io::Error` so the codec — and
/// then the worker — stop and propagate a failure rather than truncate.
struct ChannelReader {
  rx: Receiver<Chunk>,
  cur: Vec<u8>,
  pos: usize,
}

impl ChannelReader {
  fn new(rx: Receiver<Chunk>) -> Self {
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
        // only true EOF — return however much we have gathered (never a false
        // EOF mid-stream). An `Err` item aborts the read.
        match self.rx.blocking_recv() {
          Some(Ok(chunk)) => {
            self.cur = chunk;
            self.pos = 0;
            continue; // chunk may be empty; the loop re-checks and blocks again
          }
          Some(Err(err)) => return Err(io::Error::other(err.reason)),
          None => break,
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

/// Target size (bytes) of an out-channel message. The compression sink COALESCES
/// encoder writes up to this size before sending. This is load-bearing for
/// LZMA1: `LzmaWriter` flushes its range coder to the sink in tiny (often 1-byte)
/// writes, so a naive send-per-write would push millions of 1-byte messages
/// across the channel — quadratic-looking and pathologically slow. XZ / LZMA2
/// already emit block/chunk-sized writes, but coalescing is correct for all
/// three and keeps the channel messages a sensible size (matches the 64 KiB
/// decode read below). Output bytes are unaffected — only channel framing is.
const WRITE_BUFFER: usize = 64 * 1024;

/// Blocking, buffering [`io::Write`] sink that coalesces encoder output and
/// pushes it onto the worker's out-channel (compression side). `blocking_send`
/// provides the backpressure: the worker parks once the bounded channel is full.
/// A send error means the consumer went away (the output stream was cancelled /
/// dropped), which maps to an `io::Error` so the encoder stops promptly and the
/// worker unwinds. The buffered tail is flushed by [`CompressFinish`].
struct ChannelWriter {
  tx: Sender<Chunk>,
  buf: Vec<u8>,
}

impl ChannelWriter {
  fn new(tx: Sender<Chunk>) -> Self {
    Self {
      tx,
      buf: Vec::with_capacity(WRITE_BUFFER),
    }
  }

  /// Send the coalesced buffer (if any) as one out-channel message.
  fn send_buffer(&mut self) -> io::Result<()> {
    if self.buf.is_empty() {
      return Ok(());
    }
    let chunk = std::mem::take(&mut self.buf);
    match self.tx.blocking_send(Ok(chunk)) {
      Ok(()) => Ok(()),
      Err(_) => Err(io::Error::other("output stream closed")),
    }
  }
}

impl Write for ChannelWriter {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    self.buf.extend_from_slice(buf);
    if self.buf.len() >= WRITE_BUFFER {
      self.send_buffer()?;
    }
    Ok(buf.len())
  }

  fn flush(&mut self) -> io::Result<()> {
    self.send_buffer()
  }
}

/// The three lzma-rust2 / backend encoders each own a `finish(self) ->
/// io::Result<W>` that emits the format trailer, but that is not a shared trait,
/// so this local trait lets the generic compress worker finalize any of them.
/// After `finish()` writes the trailer, the returned sink is `flush()`ed so the
/// coalescing [`ChannelWriter`]'s buffered tail is sent before it is dropped.
trait CompressFinish: Write {
  fn finish_stream(self) -> io::Result<()>;
}

impl<W: Write> CompressFinish for LzmaWriter<W> {
  fn finish_stream(self) -> io::Result<()> {
    self.finish()?.flush()
  }
}

impl<W: Write> CompressFinish for Lzma2Writer<W> {
  fn finish_stream(self) -> io::Result<()> {
    self.finish()?.flush()
  }
}

impl<W: Write> CompressFinish for XzEncoder<W> {
  fn finish_stream(self) -> io::Result<()> {
    self.finish()?.flush()
  }
}

/// Compression worker: pull plaintext from `in_rx`, push it through `make`'s
/// encoder (whose sink is a [`ChannelWriter`] over `out_tx`), then flush the
/// trailer. On any failure (codec error, consumer gone, or an input-stream
/// error) it forwards a single `Err` item so the output stream errors.
fn run_compress<W, Make>(mut in_rx: Receiver<Chunk>, out_tx: Sender<Chunk>, make: Make)
where
  W: CompressFinish,
  Make: FnOnce(ChannelWriter) -> io::Result<W>,
{
  // Kept for terminal-error reporting after the encoder (which owns the data
  // `out_tx`) has been consumed/dropped.
  let err_tx = out_tx.clone();
  let outcome: Result<()> = (|| {
    let mut writer = make(ChannelWriter::new(out_tx)).map_err(backend::map_io)?;
    loop {
      match in_rx.blocking_recv() {
        Some(Ok(chunk)) => writer.write_all(&chunk).map_err(backend::map_io)?,
        // Input stream errored: forward the original napi error unchanged.
        Some(Err(err)) => return Err(err),
        None => break, // EOF: the pump dropped in_tx
      }
    }
    writer.finish_stream().map_err(backend::map_io)
  })();
  if let Err(err) = outcome {
    // Best-effort: if the consumer is already gone this send fails and is
    // ignored — the output stream is being torn down anyway.
    let _ = err_tx.blocking_send(Err(err));
  }
  // `err_tx` (and the encoder's data sender) drop here → out channel closes.
}

/// Decompression worker: build `make`'s decoder over a [`ChannelReader`] pulling
/// from `in_rx`, then pump decoded bytes onto `out_tx` in 64 KiB messages until
/// EOF, a decode error, or the consumer dropping the out receiver.
fn run_decompress<R, Make>(in_rx: Receiver<Chunk>, out_tx: Sender<Chunk>, make: Make)
where
  R: Read,
  Make: FnOnce(ChannelReader) -> io::Result<R>,
{
  let err_tx = out_tx.clone();
  let outcome: Result<()> = (|| {
    // A reader that fails to build (e.g. a malformed header) is a decode error.
    let mut reader = make(ChannelReader::new(in_rx)).map_err(backend::map_invalid)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
      let n = reader.read(&mut buf).map_err(backend::map_invalid)?;
      if n == 0 {
        break; // clean EOF
      }
      if out_tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
        return Ok(()); // consumer gone: stop quietly, no error to report
      }
    }
    Ok(())
  })();
  if let Err(err) = outcome {
    let _ = err_tx.blocking_send(Err(err));
  }
}

/// Wires the input `ReadableStream` → pump → worker → output `ReadableStream`.
///
/// The input `Reader` is obtained SYNCHRONOUSLY on the env thread (before any
/// spawn) because `read()` needs `&Env`; it is owned + `Send + 'static`, so it
/// then moves into the async pump task. The `worker` closure runs on a
/// `spawn_blocking` thread (blocking channel ops are legal only there).
fn spawn_pipeline<'env, F>(
  env: &'env Env,
  input: ReadableStream<Uint8Array>,
  worker: F,
) -> Result<ReadableStream<'env, BufferSlice<'env>>>
where
  F: FnOnce(Receiver<Chunk>, Sender<Chunk>) + Send + 'static,
{
  let mut reader = input.read()?;
  let (in_tx, in_rx) = channel::<Chunk>(CHANNEL_CAP);
  let (out_tx, out_rx) = channel::<Chunk>(CHANNEL_CAP);

  // Pump: copy the input Reader into the in-channel. Dropping `in_tx` on the way
  // out (loop end or send failure) is the worker's EOF / shutdown signal.
  spawn(async move {
    while let Some(item) = reader.next().await {
      let chunk = item.map(|bytes| bytes.to_vec());
      if in_tx.send(chunk).await.is_err() {
        break; // worker/consumer gone
      }
    }
  });

  spawn_blocking(move || worker(in_rx, out_tx));

  ReadableStream::create_with_stream_bytes(env, ReceiverStream::new(out_rx))
}

/// Validate an optional `preset` the same way the class API does (reuse the
/// shared backend validators), defaulting to [`backend::DEFAULT_PRESET`]. Runs on
/// the env thread so an out-of-range value rejects synchronously (`InvalidArg`).
fn resolve_preset(preset: Option<f64>) -> Result<u32> {
  Ok(
    preset
      .map(|value| backend::coerce_u32_index(value, "preset").and_then(backend::validate_preset))
      .transpose()
      .map_err(backend::map_invalid)?
      .unwrap_or(backend::DEFAULT_PRESET),
  )
}

/// Validate an optional `dictSize` (raw LZMA2 only). `None` keeps the pinned
/// [`backend::LZMA2_DICT_SIZE`] default (A10); an explicit value is range-checked
/// with the SAME infra as the class API so a bad size is a clean `InvalidArg`.
fn resolve_dict_size(dict_size: Option<f64>) -> Result<Option<u32>> {
  dict_size
    .map(|value| backend::coerce_u32_index(value, "dictSize").and_then(backend::validate_dict_size))
    .transpose()
    .map_err(backend::map_invalid)
}

// Each namespace gets its own module so the two Rust fns can keep the names
// `compress_stream` / `decompress_stream` (→ JS `compressStream` /
// `decompressStream`); the `namespace` attribute is what merges them into the
// shared JS `lzma` / `lzma2` / `xz` namespace object.

/// `.lzma` (LZMA1) Web Streams transforms.
pub mod lzma {
  use napi::bindgen_prelude::*;
  use napi_derive::napi;

  use super::{resolve_preset, run_compress, run_decompress, spawn_pipeline};
  use crate::backend;
  use crate::stream::CompressorOptions;

  /// Compress a `ReadableStream<Uint8Array>` into a `.lzma` byte stream.
  #[napi(namespace = "lzma")]
  pub fn compress_stream<'env>(
    env: &'env Env,
    input: ReadableStream<Uint8Array>,
    options: Option<CompressorOptions>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    let preset = resolve_preset(options.unwrap_or_default().preset)?;
    spawn_pipeline(env, input, move |in_rx, out_tx| {
      run_compress(in_rx, out_tx, move |sink| {
        backend::lzma_writer(sink, preset)
      });
    })
  }

  /// Decompress a `.lzma` `ReadableStream<Uint8Array>` into a plaintext stream.
  #[napi(namespace = "lzma")]
  pub fn decompress_stream<'env>(
    env: &'env Env,
    input: ReadableStream<Uint8Array>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    spawn_pipeline(env, input, |in_rx, out_tx| {
      run_decompress(in_rx, out_tx, backend::lzma_reader);
    })
  }
}

/// Raw LZMA2 Web Streams transforms (dictionary pinned out of band, A10).
pub mod lzma2 {
  use napi::bindgen_prelude::*;
  use napi_derive::napi;

  use super::{resolve_dict_size, resolve_preset, run_compress, run_decompress, spawn_pipeline};
  use crate::backend;
  use crate::stream::{Lzma2CompressorOptions, Lzma2DecompressorOptions};

  /// Compress a `ReadableStream<Uint8Array>` into a raw LZMA2 byte stream.
  #[napi(namespace = "lzma2")]
  pub fn compress_stream<'env>(
    env: &'env Env,
    input: ReadableStream<Uint8Array>,
    options: Option<Lzma2CompressorOptions>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    let opts = options.unwrap_or_default();
    let preset = resolve_preset(opts.preset)?;
    let dict_size = resolve_dict_size(opts.dict_size)?;
    spawn_pipeline(env, input, move |in_rx, out_tx| {
      run_compress(in_rx, out_tx, move |sink| {
        Ok(backend::lzma2_writer(sink, preset, dict_size))
      });
    })
  }

  /// Decompress a raw LZMA2 `ReadableStream<Uint8Array>` into a plaintext stream.
  #[napi(namespace = "lzma2")]
  pub fn decompress_stream<'env>(
    env: &'env Env,
    input: ReadableStream<Uint8Array>,
    options: Option<Lzma2DecompressorOptions>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    let dict_size = resolve_dict_size(options.unwrap_or_default().dict_size)?;
    spawn_pipeline(env, input, move |in_rx, out_tx| {
      run_decompress(in_rx, out_tx, move |src| {
        Ok(backend::lzma2_reader(src, dict_size))
      });
    })
  }
}

/// `.xz` Web Streams transforms (empty-input-safe via the shared `XzEncoder`).
pub mod xz {
  use napi::bindgen_prelude::*;
  use napi_derive::napi;

  use super::{resolve_preset, run_compress, run_decompress, spawn_pipeline};
  use crate::backend::{self, XzEncoder};
  use crate::stream::CompressorOptions;

  /// Compress a `ReadableStream<Uint8Array>` into an `.xz` byte stream.
  #[napi(namespace = "xz")]
  pub fn compress_stream<'env>(
    env: &'env Env,
    input: ReadableStream<Uint8Array>,
    options: Option<CompressorOptions>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    let preset = resolve_preset(options.unwrap_or_default().preset)?;
    spawn_pipeline(env, input, move |in_rx, out_tx| {
      run_compress(in_rx, out_tx, move |sink| XzEncoder::new(sink, preset));
    })
  }

  /// Decompress an `.xz` `ReadableStream<Uint8Array>` into a plaintext stream.
  #[napi(namespace = "xz")]
  pub fn decompress_stream<'env>(
    env: &'env Env,
    input: ReadableStream<Uint8Array>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    spawn_pipeline(env, input, |in_rx, out_tx| {
      run_decompress(in_rx, out_tx, backend::xz_reader);
    })
  }
}
