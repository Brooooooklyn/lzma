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

use std::io::{self, Write};

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

      /// Feed one chunk. Returns the bytes produced so far (possibly empty) as a
      /// zero-copy view; only the concatenation of every `update()` + `finish()`
      /// is a valid stream. Never flushes the encoder (byte-identity invariant).
      #[napi]
      pub fn update<'env>(
        &mut self,
        env: &'env Env,
        chunk: Uint8Array,
      ) -> Result<BufferSlice<'env>> {
        let writer = self.inner.as_mut().ok_or_else(already_finished)?;
        writer.write_all(chunk.as_ref()).map_err(map_io)?;
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
