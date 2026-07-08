//! Shared format wiring for the `lzma` / `lzma2` / `xz` namespaces, backed by
//! the pure-Rust [`lzma_rust2`] crate.
//!
//! This module is the single source of truth for how each container format is
//! wired up. The one-shot functions in `lib.rs` use the `*_compress` /
//! `*_decompress` helpers here, and later tasks (class + streaming layers) are
//! expected to reuse the shared writers/readers: [`XzEncoder`] plus the
//! `*_writer` / `*_reader` constructors. All XZ compression goes through
//! [`XzEncoder`], which owns the empty-input workaround so no downstream caller
//! can miss it. Keep these signatures stable.

use std::io::{self, Read, Write};

use lzma_rust2::{
  Lzma2Options, Lzma2Reader, Lzma2Writer, LzmaOptions, LzmaReader, LzmaWriter, XzOptions, XzReader,
  XzWriter,
};

/// Canonical LZMA2 dictionary size (8 MiB).
///
/// Matches `lzma_rust2`'s `LzmaOptions::DICT_SIZE_DEFAULT`. Raw LZMA2 carries no
/// in-band dictionary size, so the encoder and decoder must agree out of band.
/// We pin both sides to this value regardless of preset (A10).
pub const LZMA2_DICT_SIZE: u32 = 8 << 20;

/// Default liblzma preset (level 6).
pub const DEFAULT_PRESET: u32 = 6;

/// Canonical empty `.xz` stream with a CRC64 integrity check.
///
/// Workaround for an upstream `lzma_rust2` bug: `XzWriter` only starts a block
/// from inside `write()`, so for empty input `finish()` finalizes a block that
/// was never started and emits a malformed stream. [`XzEncoder::finish`] emits
/// these spec-defined bytes instead. They are byte-identical to liblzma's
/// default (`xz`) empty output and are asserted to round-trip through our own
/// reader in the tests below.
const EMPTY_XZ_CRC64: [u8; 32] = [
  0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04, 0xe6, 0xd6, 0xb4, 0x46, 0x00, 0x00, 0x00, 0x00,
  0x1c, 0xdf, 0x44, 0x21, 0x1f, 0xb6, 0xf3, 0x7d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x59, 0x5a,
];

/// Maps a generic I/O or encode error to a napi error.
pub fn map_io(err: io::Error) -> napi::Error {
  napi::Error::from_reason(err.to_string())
}

/// Maps a decode failure to a napi `InvalidArg` error (malformed input bytes).
pub fn map_invalid(err: io::Error) -> napi::Error {
  napi::Error::new(napi::Status::InvalidArg, err.to_string())
}

// ---------------------------------------------------------------------------
// Low-level constructors (shared with the future class + stream layers).
// ---------------------------------------------------------------------------

/// `.lzma` encoder: 13-byte header, end marker, unknown uncompressed size.
pub fn lzma_writer<W: Write>(writer: W, preset: u32) -> io::Result<LzmaWriter<W>> {
  LzmaWriter::new_use_header(writer, &LzmaOptions::with_preset(preset), None)
}

/// `.lzma` decoder: reads dict size + uncompressed size from the header, so it
/// decodes foreign presets and dictionary sizes.
pub fn lzma_reader<R: Read>(reader: R) -> io::Result<LzmaReader<R>> {
  LzmaReader::new_mem_limit(reader, u32::MAX, None)
}

/// Raw LZMA2 encoder with the dictionary pinned so decoders can be pinned to
/// the same size (A10): raw LZMA2 carries no in-band dictionary size.
pub fn lzma2_writer<W: Write>(writer: W, preset: u32, dict_size: Option<u32>) -> Lzma2Writer<W> {
  let mut options = Lzma2Options::with_preset(preset);
  options.lzma_options.dict_size = dict_size.unwrap_or(LZMA2_DICT_SIZE);
  Lzma2Writer::new(writer, options)
}

/// Raw LZMA2 decoder with the dictionary pinned to match the encoder (A10).
pub fn lzma2_reader<R: Read>(reader: R, dict_size: Option<u32>) -> Lzma2Reader<R> {
  Lzma2Reader::new(reader, dict_size.unwrap_or(LZMA2_DICT_SIZE), None)
}

/// Raw XZ block writer (default integrity check = CRC64).
///
/// Internal building block for [`XzEncoder`]. A bare `XzWriter` mis-encodes
/// empty input (see [`EMPTY_XZ_CRC64`]), so it is deliberately not exposed:
/// every compressor surface must go through [`XzEncoder`], which owns the
/// workaround.
fn xz_writer<W: Write>(writer: W, preset: u32) -> io::Result<XzWriter<W>> {
  XzWriter::new(writer, XzOptions::with_preset(preset))
}

/// XZ decoder (allows concatenated `.xz` streams).
pub fn xz_reader<R: Read>(reader: R) -> io::Result<XzReader<R>> {
  Ok(XzReader::new(reader, true))
}

/// Backend-owned XZ compressor that encapsulates the empty-input workaround for
/// every caller (one-shot today; the class and stream layers later).
///
/// Upstream `XzWriter` only starts a block from inside `write()`, so driving it
/// to `finish()` without a non-empty write finalizes a never-started block and
/// emits a malformed `.xz`. `XzEncoder` fixes this once, in the shared layer, so
/// no downstream caller can reintroduce the bug:
///
/// * It stays in the `Empty` state until the first non-empty write, so stray
///   `write(b"")` chunks are harmless no-ops (relevant to streaming callers).
/// * If `finish()` runs while still empty, it emits the canonical
///   [`EMPTY_XZ_CRC64`] stream instead of driving the broken `XzWriter`.
///
/// It is generic over `W: Write`, so the one-shot (`Vec<u8>` sink) and future
/// streaming sinks use the identical path.
pub struct XzEncoder<W: Write> {
  state: XzEncoderState<W>,
}

// `XzWriter` is much larger than the `Empty` variant, but that only exists on
// the sink for a single encoder, so the size disparity is not worth boxing.
#[allow(clippy::large_enum_variant)]
enum XzEncoderState<W: Write> {
  /// Nothing written yet; holds the sink and preset for a lazy start.
  Empty { inner: W, preset: u32 },
  /// The block was started on the first non-empty write.
  Started(XzWriter<W>),
  /// Transient placeholder used only while swapping `Empty` -> `Started`. A
  /// lingering `Done` means the lazy `XzWriter` construction failed.
  Done,
}

impl<W: Write> XzEncoder<W> {
  /// Create an XZ encoder over `inner` at the given preset (CRC64 check).
  ///
  /// No bytes are written to the sink until the first non-empty `write` (or,
  /// for empty input, until `finish`).
  pub fn new(inner: W, preset: u32) -> io::Result<Self> {
    Ok(Self {
      state: XzEncoderState::Empty { inner, preset },
    })
  }

  /// Lazily start the block on first use and return the live writer.
  fn ensure_started(&mut self) -> io::Result<&mut XzWriter<W>> {
    if matches!(self.state, XzEncoderState::Empty { .. }) {
      let XzEncoderState::Empty { inner, preset } =
        std::mem::replace(&mut self.state, XzEncoderState::Done)
      else {
        unreachable!("state is Empty in this branch")
      };
      self.state = XzEncoderState::Started(xz_writer(inner, preset)?);
    }
    match &mut self.state {
      XzEncoderState::Started(writer) => Ok(writer),
      _ => Err(io::Error::other("XzEncoder failed to start a block")),
    }
  }

  /// Returns a mutable reference to the inner sink, in both the `Empty` and
  /// `Started` states.
  ///
  /// Lets streaming callers drain the already-produced bytes with
  /// `std::mem::take` between writes without disturbing the encoder: the
  /// `XzWriter`'s block accounting tracks total bytes written independently of
  /// what currently sits in the sink, so emptying it is safe.
  pub fn sink_mut(&mut self) -> &mut W {
    match &mut self.state {
      XzEncoderState::Empty { inner, .. } => inner,
      XzEncoderState::Started(writer) => writer.inner_mut(),
      // `Done` is only ever swapped in transiently inside `ensure_started`; it
      // never persists across a call that could reach this accessor.
      XzEncoderState::Done => unreachable!("XzEncoder sink accessed in transient Done state"),
    }
  }

  /// Finish the stream and return the inner sink.
  ///
  /// If no non-empty data was ever written, emits [`EMPTY_XZ_CRC64`] rather than
  /// finalizing the never-started upstream block.
  pub fn finish(self) -> io::Result<W> {
    match self.state {
      XzEncoderState::Empty { mut inner, .. } => {
        inner.write_all(&EMPTY_XZ_CRC64)?;
        Ok(inner)
      }
      XzEncoderState::Started(writer) => writer.finish(),
      XzEncoderState::Done => Err(io::Error::other("XzEncoder is in an invalid state")),
    }
  }
}

impl<W: Write> Write for XzEncoder<W> {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    if buf.is_empty() {
      // Never start a block for an empty chunk; keeps stray `write(b"")` safe.
      return Ok(0);
    }
    self.ensure_started()?.write(buf)
  }

  fn flush(&mut self) -> io::Result<()> {
    match &mut self.state {
      XzEncoderState::Started(writer) => writer.flush(),
      // Nothing has been written yet, so there is nothing to flush.
      _ => Ok(()),
    }
  }
}

// ---------------------------------------------------------------------------
// One-shot helpers used by the `define_functions!` macro in `lib.rs`.
// ---------------------------------------------------------------------------

/// Compresses `data` into a `.lzma` container.
pub fn lzma_compress(data: &[u8]) -> io::Result<Vec<u8>> {
  let mut output = Vec::new();
  let mut writer = lzma_writer(&mut output, DEFAULT_PRESET)?;
  writer.write_all(data)?;
  writer.finish()?;
  Ok(output)
}

/// Decompresses a `.lzma` container.
pub fn lzma_decompress(data: &[u8]) -> io::Result<Vec<u8>> {
  let mut output = Vec::new();
  lzma_reader(data)?.read_to_end(&mut output)?;
  Ok(output)
}

/// Compresses `data` into a raw LZMA2 stream.
pub fn lzma2_compress(data: &[u8]) -> io::Result<Vec<u8>> {
  let mut output = Vec::new();
  let mut writer = lzma2_writer(&mut output, DEFAULT_PRESET, None);
  writer.write_all(data)?;
  writer.finish()?;
  Ok(output)
}

/// Decompresses a raw LZMA2 stream.
pub fn lzma2_decompress(data: &[u8]) -> io::Result<Vec<u8>> {
  let mut output = Vec::new();
  lzma2_reader(data, None).read_to_end(&mut output)?;
  Ok(output)
}

/// Compresses `data` into an `.xz` container.
///
/// Drives the shared [`XzEncoder`], which handles empty input (the upstream
/// `XzWriter` empty-block bug) so this path needs no special-casing.
pub fn xz_compress(data: &[u8]) -> io::Result<Vec<u8>> {
  let mut encoder = XzEncoder::new(Vec::new(), DEFAULT_PRESET)?;
  encoder.write_all(data)?;
  encoder.finish()
}

/// Decompresses an `.xz` container.
pub fn xz_decompress(data: &[u8]) -> io::Result<Vec<u8>> {
  let mut output = Vec::new();
  xz_reader(data)?.read_to_end(&mut output)?;
  Ok(output)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Deterministic pseudo-random bytes (LCG); used to build a distinctive
  /// block that will not accidentally match unrelated filler.
  fn lcg_bytes(seed: u32, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut x = seed;
    for _ in 0..len {
      x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
      out.push((x >> 24) as u8);
    }
    out
  }

  /// A10 regression: raw LZMA2 has no in-band dictionary size.
  ///
  /// The input places two identical 1 MiB blocks 10 MiB apart. At the max
  /// preset (9) the encoder's dictionary is 64 MiB, so the second block is
  /// coded as a ~10 MiB back-reference to the first. The decoder is pinned to
  /// an 8 MiB dictionary, so that reference points outside its window and the
  /// stream fails to decode. Pinning the *encoder* dictionary to
  /// `LZMA2_DICT_SIZE` keeps every back-reference inside the 8 MiB window, so
  /// the data round-trips.
  #[test]
  fn lzma2_preset9_long_backreference_round_trips() {
    let block = lcg_bytes(0xDEAD_BEEF, 1 << 20); // 1 MiB distinctive block
    let filler = lcg_bytes(0x0BAD_F00D, 9 << 20); // 9 MiB unrelated filler

    let mut input = Vec::with_capacity(11 << 20);
    input.extend_from_slice(&block);
    input.extend_from_slice(&filler);
    input.extend_from_slice(&block); // repeat ~10 MiB later (> 8 MiB window)

    let mut compressed = Vec::new();
    let mut writer = lzma2_writer(&mut compressed, 9, None);
    writer.write_all(&input).unwrap();
    writer.finish().unwrap();

    let mut output = Vec::new();
    lzma2_reader(compressed.as_slice(), None)
      .read_to_end(&mut output)
      .expect("preset-9 LZMA2 with a > 8 MiB back-reference must decode (A10)");

    assert_eq!(output, input, "round-trip mismatch");
  }

  /// The hard-coded empty `.xz` workaround must decode back to empty through
  /// our own reader (guards against the constant drifting out of spec).
  #[test]
  fn xz_empty_round_trips() {
    let compressed = xz_compress(b"").unwrap();
    assert_eq!(compressed, EMPTY_XZ_CRC64);
    assert!(xz_decompress(&compressed).unwrap().is_empty());
  }

  /// Drive the SHARED abstraction directly (not via `xz_compress`): finishing an
  /// `XzEncoder` that never received a write must emit the canonical empty
  /// stream (not the malformed output a bare upstream `XzWriter` would produce)
  /// and decode back to empty. This is the guard for every future compressor
  /// surface (class / stream), which reuse `XzEncoder` rather than `xz_compress`.
  #[test]
  fn xz_encoder_finish_without_write_emits_canonical_empty() {
    let encoder = XzEncoder::new(Vec::new(), DEFAULT_PRESET).unwrap();
    let compressed = encoder.finish().unwrap();
    assert_eq!(
      compressed, EMPTY_XZ_CRC64,
      "finishing an unwritten XzEncoder must emit the canonical empty stream"
    );
    assert!(
      xz_decompress(&compressed).unwrap().is_empty(),
      "the canonical empty stream must decode to empty"
    );
  }

  /// A stray `write(b"")` must not start a block; finishing afterwards still
  /// yields the valid empty stream (relevant to streaming callers that may push
  /// empty chunks).
  #[test]
  fn xz_encoder_empty_write_then_finish_is_valid_empty() {
    let mut encoder = XzEncoder::new(Vec::new(), DEFAULT_PRESET).unwrap();
    assert_eq!(
      encoder.write(b"").unwrap(),
      0,
      "empty write must be a no-op"
    );
    let compressed = encoder.finish().unwrap();
    assert_eq!(compressed, EMPTY_XZ_CRC64);
    assert!(xz_decompress(&compressed).unwrap().is_empty());
  }

  /// Empty input must round-trip for every format.
  #[test]
  fn empty_round_trips_all_formats() {
    assert!(
      lzma_decompress(&lzma_compress(b"").unwrap())
        .unwrap()
        .is_empty()
    );
    assert!(
      lzma2_decompress(&lzma2_compress(b"").unwrap())
        .unwrap()
        .is_empty()
    );
    assert!(
      xz_decompress(&xz_compress(b"").unwrap())
        .unwrap()
        .is_empty()
    );
  }
}
