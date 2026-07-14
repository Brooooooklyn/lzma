## [1.5.1](https://github.com/Brooooooklyn/lzma/compare/v1.5.0...v1.5.1) (2026-07-14)


### Bug Fixes

* **ci:** rm x64 host helper after cross builds so it can't clobber the real binary ([#391](https://github.com/Brooooooklyn/lzma/issues/391)) ([fce3555](https://github.com/Brooooooklyn/lzma/commit/fce355580163569080ca9526df48208633d17083)), closes [#276](https://github.com/Brooooooklyn/lzma/issues/276) [#276](https://github.com/Brooooooklyn/lzma/issues/276)
# [1.5.0](https://github.com/Brooooooklyn/lzma/compare/v1.4.5...v1.5.0) (2026-07-13)


### Bug Fixes

* bump napi to 3.10.5 for the FunctionRef off-thread-drop fix ([#388](https://github.com/Brooooooklyn/lzma/issues/388)) ([976348e](https://github.com/Brooooooklyn/lzma/commit/976348ee48161e604b8cd51793e809f5f2119e6c)), closes [napi-rs/napi-rs#3394](https://github.com/napi-rs/napi-rs/issues/3394)
* **deps:** update rust crate lzma-rust2 to 0.16 ([#381](https://github.com/Brooooooklyn/lzma/issues/381)) ([36cf3ee](https://github.com/Brooooooklyn/lzma/commit/36cf3ee0e00e43cbe77b6a314d47e799a4d8c651))
* remove angle bracket from Node card alt text so GitHub renders the tag ([b42c61f](https://github.com/Brooooooklyn/lzma/commit/b42c61f5d0853f2734e576dfdc1ec1d3f8128f6f))


### Features

* add script-jail lifecycle-script audit gate ([#383](https://github.com/Brooooooklyn/lzma/issues/383)) ([8f13f5a](https://github.com/Brooooooklyn/lzma/commit/8f13f5a164ad306374c9acaf001b9357582b1210))
* streaming compress/decompress (class + Web Streams API) for lzma/lzma2/xz ([#378](https://github.com/Brooooooklyn/lzma/issues/378)) ([d482c7d](https://github.com/Brooooooklyn/lzma/commit/d482c7d1553eb6b60806b5a8b98d24af41ef918d)), closes [#372](https://github.com/Brooooooklyn/lzma/issues/372)
## Unreleased


### Features

* **streaming:** add an incremental streaming API for `xz`, `lzma`, and `lzma2` — `Compressor` / `Decompressor` classes (`update()` / `finish()`), a WHATWG Web Streams `compressStream` / `decompressStream` per namespace, and Node `Duplex` `createCompressStream` / `createDecompressStream` convenience factories. The one-shot API is unchanged; the new surface is purely additive. Under wasm/browser the Web Streams API falls back to a buffered polyfill (the incremental class decode stays native).
* **backend:** swap the compression backend from `lzma-rs` to the pure-Rust `lzma-rust2` crate. The one-shot API behavior is unchanged and the output remains standard, liblzma-compatible `.xz` / `.lzma`.


### Notes

* **lzma2 dictionary:** raw LZMA2 carries no dictionary size in-band, so it uses a fixed 8 MiB dictionary by default. Override it via a symmetric `{ dictSize }` on both the compressor and the decompressor — they must agree. A decoder configured with a mismatched (smaller) dictionary fails cleanly with an `InvalidArg` error; it never silently corrupts the output.
* **stream trailer:** the `lzma` / `lzma2` stream decoders complete at the in-band end marker and ignore any trailing bytes after a complete frame (as with the one-shot API), while `xz` validates its framed trailer.


### Known Limitations

* Cancelling a Web `compressStream` / `decompressStream` output while a `read()` is still pending on a stalled or never-ending input can leak one worker thread until the process exits. Normal cancels — before reading, after data has flowed, or on any finite input — are unaffected. (Root cause: napi's stream cancel cannot interrupt a pull already in flight; a full fix needs an upstream napi cancel hook.)



## [1.4.5](https://github.com/Brooooooklyn/lzma/compare/v1.4.4...v1.4.5) (2025-08-10)



## [1.4.4](https://github.com/Brooooooklyn/lzma/compare/v1.4.3...v1.4.4) (2025-07-23)


### Features

* upgrade to NAPI-RS 3.0 stable ([#280](https://github.com/Brooooooklyn/lzma/issues/280)) ([0a1188a](https://github.com/Brooooooklyn/lzma/commit/0a1188aac2077613b05fa0ea6e132db1155e6d87))



## [1.4.3](https://github.com/Brooooooklyn/lzma/compare/v1.4.2...v1.4.3) (2025-05-19)


### Bug Fixes

* browser field in package.json ([#260](https://github.com/Brooooooklyn/lzma/issues/260)) ([6f815bd](https://github.com/Brooooooklyn/lzma/commit/6f815bd5e7c8a4488fe7792b7bc2274252c29a51))



## [1.4.2](https://github.com/Brooooooklyn/lzma/compare/v1.4.1...v1.4.2) (2025-05-04)



## [1.4.1](https://github.com/Brooooooklyn/lzma/compare/v1.4.0...v1.4.1) (2024-09-21)


### Bug Fixes

* exports browser field ([#192](https://github.com/Brooooooklyn/lzma/issues/192)) ([88c268f](https://github.com/Brooooooklyn/lzma/commit/88c268fe6d7b2d456f811c27f6f54386eac70558))



# [1.4.0](https://github.com/Brooooooklyn/lzma/compare/v1.3.1...v1.4.0) (2024-09-16)


### Bug Fixes

* **deps:** update rust crate napi to 3.0.0-alpha ([#176](https://github.com/Brooooooklyn/lzma/issues/176)) ([cd01f0e](https://github.com/Brooooooklyn/lzma/commit/cd01f0e359155b13bca5078a1443fc1a763cd686))
* **deps:** update rust crate napi-derive to 3.0.0-alpha ([#175](https://github.com/Brooooooklyn/lzma/issues/175)) ([9fb995b](https://github.com/Brooooooklyn/lzma/commit/9fb995bc804b01e09a8523768501c73b093f9731))



## [1.3.1](https://github.com/Brooooooklyn/lzma/compare/v1.3.0...v1.3.1) (2024-04-30)

### Bug Fixes

- add missing browser field ([5f56910](https://github.com/Brooooooklyn/lzma/commit/5f5691006fcd175015fd9a16aae9a944984f9a9f))

# [1.3.0](https://github.com/Brooooooklyn/lzma/compare/v1.2.1...v1.3.0) (2024-04-29)

### Features

- support wasi target ([#152](https://github.com/Brooooooklyn/lzma/issues/152)) ([f64bf9b](https://github.com/Brooooooklyn/lzma/commit/f64bf9bf46c0ea8079e8cd6818cf11082d01bdf4))

## [1.2.1](https://github.com/Brooooooklyn/lzma/compare/v1.2.0...v1.2.1) (2023-12-05)

### Bug Fixes

- missing exports ([73b101b](https://github.com/Brooooooklyn/lzma/commit/73b101b2c49d45a4dd0c255c33287f2b952d13db))

# [1.2.0](https://github.com/Brooooooklyn/lzma/compare/v1.1.2...v1.2.0) (2023-12-05)

### Bug Fixes

- **deps:** update rust crate lzma-rs to 0.3 ([#71](https://github.com/Brooooooklyn/lzma/issues/71)) ([04345d0](https://github.com/Brooooooklyn/lzma/commit/04345d08f215a41784cd13008f910e4219e53a8f))

### Features

- provide sync api ([#128](https://github.com/Brooooooklyn/lzma/issues/128)) ([bdf5fff](https://github.com/Brooooooklyn/lzma/commit/bdf5fffb1a80fcd0a225279b7f7f16227d549528))

## [1.1.2](https://github.com/Brooooooklyn/lzma/compare/v1.1.1...v1.1.2) (2021-12-23)

### Bug Fixes

- publish missing .d.ts file ([a393809](https://github.com/Brooooooklyn/lzma/commit/a393809d38dd4f4d721811109ca48fea9f58ab18))

## [1.1.1](https://github.com/Brooooooklyn/lzma/compare/v1.1.0...v1.1.1) (2021-12-22)

### Bug Fixes

- missing esbuild dependency ([5cfb37b](https://github.com/Brooooooklyn/lzma/commit/5cfb37b41d65528a36f701ce4aa7ba8a089be52f))

# [1.1.0](https://github.com/Brooooooklyn/lzma/compare/v1.0.0...v1.1.0) (2021-12-22)

### Features

- upgrade to napi-2 ([8297ee4](https://github.com/Brooooooklyn/lzma/commit/8297ee4f6a8c5693396dcbd9066db59b42d5e942))

# 1.0.0 (2021-09-17)

### Features

- lzma and lzma2 ([a97d0ef](https://github.com/Brooooooklyn/lzma/commit/a97d0ef74ead7eececaad17e5201d50e11c3e662))
- support mjs and import subpath ([803e85f](https://github.com/Brooooooklyn/lzma/commit/803e85f5671f2dec3c57a0e574de62a75e64e08c))
