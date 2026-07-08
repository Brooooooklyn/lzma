//! Shared format wiring for the `lzma` / `lzma2` / `xz` namespaces, backed by
//! the pure-Rust [`lzma_rust2`] crate.
//!
//! This module is the single source of truth for how each container format is
//! wired up. The one-shot functions in `lib.rs` use the `*_compress` /
//! `*_decompress` helpers here, and later tasks (class + streaming layers) are
//! expected to reuse the low-level constructors (`*_writer` / `*_reader`).
//! Keep the constructor signatures stable.

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
/// was never started and emits a malformed stream. We emit the spec-defined
/// empty stream instead. These bytes are byte-identical to liblzma's default
/// (`xz`) empty output and are asserted to round-trip through our own reader in
/// the tests below.
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

/// XZ encoder (default integrity check = CRC64).
pub fn xz_writer<W: Write>(writer: W, preset: u32) -> io::Result<XzWriter<W>> {
  XzWriter::new(writer, XzOptions::with_preset(preset))
}

/// XZ decoder (allows concatenated `.xz` streams).
pub fn xz_reader<R: Read>(reader: R) -> io::Result<XzReader<R>> {
  Ok(XzReader::new(reader, true))
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
pub fn xz_compress(data: &[u8]) -> io::Result<Vec<u8>> {
  if data.is_empty() {
    // Upstream `XzWriter` mis-encodes empty input; emit the canonical stream.
    return Ok(EMPTY_XZ_CRC64.to_vec());
  }
  let mut output = Vec::new();
  let mut writer = xz_writer(&mut output, DEFAULT_PRESET)?;
  writer.write_all(data)?;
  writer.finish()?;
  Ok(output)
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
