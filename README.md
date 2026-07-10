# `@napi-rs/lzma`

![https://github.com/Brooooooklyn/lzma/actions](https://github.com/Brooooooklyn/lzma/workflows/CI/badge.svg)
![](https://img.shields.io/npm/dm/@napi-rs/lzma.svg?sanitize=true)
[![Install size](https://packagephobia.com/badge?p=@napi-rs/lzma)](https://packagephobia.com/result?p=@napi-rs/lzma)

`lzma` / `lzma2` / `xz` compression for Node.js and the browser, backed by the pure-Rust [lzma-rust2](https://docs.rs/lzma-rust2) crate via [napi-rs](https://napi.rs).

> 🚀 Help me to become a full-time open-source developer by [sponsoring me on Github](https://github.com/sponsors/Brooooooklyn)

## Install

```
yarn add @napi-rs/lzma
```

## Support matrix

<!-- Absolute raw URLs, not relative paths: npmjs.com rewrites <img src> to
     raw.githubusercontent.com but does NOT rewrite <source srcset>, so a relative
     srcset 404s on npm for every dark-mode visitor. -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Brooooooklyn/lzma/HEAD/assets/support-node-dark.svg">
  <img alt="Node.js support: v22.20 to v26. Node 23 and 24.0 to 24.11 are excluded. CI tests 22 and 24; 26 is supported but not in the CI matrix." src="https://raw.githubusercontent.com/Brooooooklyn/lzma/HEAD/assets/support-node-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Brooooooklyn/lzma/HEAD/assets/support-platforms-dark.svg">
  <img alt="Platforms — 16 prebuilt native targets. CI-tested: Linux x64 gnu and musl, Linux arm64 gnu and musl, Linux armv7 gnu, Windows x64, arm64 and x32, macOS x64 and arm64, FreeBSD x64. Non-blocking: Linux ppc64le and s390x. Built but untested: Linux riscv64, Android arm64 and armv7." src="https://raw.githubusercontent.com/Brooooooklyn/lzma/HEAD/assets/support-platforms-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Brooooooklyn/lzma/HEAD/assets/support-browser-dark.svg">
  <img alt="Browser — ships as wasm32-wasi, picked up by bundlers via the browser export condition. Requires cross-origin isolation (COOP + COEP) for SharedArrayBuffer." src="https://raw.githubusercontent.com/Brooooooklyn/lzma/HEAD/assets/support-browser-light.svg">
</picture>

<details>
<summary>Full matrix as text</summary>

### Node.js

`engines.node` is `^22.20 || ^24.12 || >=25` — a deliberately non-contiguous range:

| Range            | Supported | Note                                          |
| ---------------- | --------- | --------------------------------------------- |
| `< 22.20`        | no        |                                               |
| `22.20` – `22.x` | yes       | tested in CI                                  |
| `23.x`           | no        | reached end-of-life 2025-06-01                |
| `24.0` – `24.11` | no        |                                               |
| `24.12` – `24.x` | yes       | tested in CI                                  |
| `25.x`           | yes       | permitted, but reached end-of-life 2026-06-01 |
| `26` and later   | yes       | not in the CI matrix                          |

Release-line status as of 2026-07-10: 22 is Maintenance LTS, 24 is Active LTS, 26 is Current.

**Why these exact cutoffs?** They are a support policy, not a technical limit. The only hard
floor in the shipped code is **Node 22.12**, where `require(esm)` became unflagged — `main.js`
loads `stream-polyfill.mjs` with `require`. The native binding itself asks for nothing newer
than Node-API 5. The `^22.20 || ^24.12 || >=25` range was inherited from the test toolchain
(`ava` declares `^22.20 || ^24.12 || >=26`) and predates the `require(esm)` code by two months.
Node 23 and 24.0–24.11 are dropped by policy; the code runs on them.

### Targets

| Rust triple                     | Platform             | CI                                 |
| ------------------------------- | -------------------- | ---------------------------------- |
| `x86_64-pc-windows-msvc`        | Windows x64          | tested — node 22, 24               |
| `aarch64-pc-windows-msvc`       | Windows arm64        | tested — node 22, 24               |
| `i686-pc-windows-msvc`          | Windows x32          | tested — node 22 (x86), `--serial` |
| `x86_64-apple-darwin`           | macOS x64            | tested — node 22, 24               |
| `aarch64-apple-darwin`          | macOS arm64          | tested — node 22, 24               |
| `x86_64-unknown-linux-gnu`      | Linux x64 gnu        | tested — node 22, 24               |
| `x86_64-unknown-linux-musl`     | Linux x64 musl       | tested — node 22, 24               |
| `aarch64-unknown-linux-gnu`     | Linux arm64 gnu      | tested — node 22, 24               |
| `aarch64-unknown-linux-musl`    | Linux arm64 musl     | tested — node 22, 24               |
| `armv7-unknown-linux-gnueabihf` | Linux armv7 gnu      | tested — node 22 only, `--serial`  |
| `x86_64-unknown-freebsd`        | FreeBSD x64          | tested — node version unpinned     |
| `powerpc64le-unknown-linux-gnu` | Linux ppc64le        | non-blocking (`continue-on-error`) |
| `s390x-unknown-linux-gnu`       | Linux s390x          | non-blocking (`continue-on-error`) |
| `riscv64gc-unknown-linux-gnu`   | Linux riscv64        | built, not tested                  |
| `aarch64-linux-android`         | Android arm64        | built, not tested                  |
| `arm-linux-androideabi`         | Android armv7        | built, not tested                  |
| `wasm32-wasi-preview1-threads`  | wasm32-wasi, browser | built, not tested                  |

Seventeen targets: eleven CI-tested, two non-blocking, four built but not exercised.

### Browser

Bundlers resolve `@napi-rs/lzma-wasm32-wasi` through the `browser` export condition. The wasm
build allocates shared memory and spawns worker threads, so `SharedArrayBuffer` must be
available — the page has to be
[cross-origin isolated](https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated),
served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

</details>

## API

### xz

```js
import { compress, decompress } from '@napi-rs/lzma/xz'

const compressed = await compress('Hello napi-rs 🚀')

const decompressed = await decompress(compressed)

console.log(decompressed.toString('utf8')) // Hello napi-rs 🚀
```

### lzma

```js
import { compress, decompress } from '@napi-rs/lzma/lzma'

const compressed = await compress('Hello napi-rs 🚀')

const decompressed = await decompress(compressed)

console.log(decompressed.toString('utf8')) // Hello napi-rs 🚀
```

### lzma2

```js
import { compress, decompress } from '@napi-rs/lzma/lzma2'

const compressed = await compress('Hello napi-rs 🚀')

const decompressed = await decompress(compressed)

console.log(decompressed.toString('utf8')) // Hello napi-rs 🚀
```

## Streaming

Every namespace (`xz`, `lzma`, `lzma2`) additionally exposes an incremental streaming API. The one-shot `compress` / `decompress` above are unchanged; streaming is purely additive.

### Incremental classes

Feed data chunk-by-chunk with `update()` and flush with `finish()`. The valid stream is the concatenation of every `update()` output plus the `finish()` tail.

```js
import { Compressor, Decompressor } from '@napi-rs/lzma/xz'

const compressor = new Compressor({ preset: 6 })
const parts = [compressor.update('Hello '), compressor.update('napi-rs 🚀'), await compressor.finish()]
const compressed = Buffer.concat(parts)

const decompressor = new Decompressor()
const restored = Buffer.concat([decompressor.update(compressed), await decompressor.finish()])
console.log(restored.toString('utf8')) // Hello napi-rs 🚀
```

The top-level entry re-exports the same classes with format-qualified names: `XzCompressor` / `XzDecompressor`, `LzmaCompressor` / `LzmaDecompressor`, `Lzma2Compressor` / `Lzma2Decompressor`.

### Web Streams

Each namespace exposes a WHATWG [Web Streams](https://developer.mozilla.org/docs/Web/API/Streams_API) API — `Uint8Array` in, compressed `Uint8Array` out:

```js
import { compressStream, decompressStream } from '@napi-rs/lzma/xz'

const compressed = source.pipeThrough(new TransformStream()) // any ReadableStream<Uint8Array>
const restored = decompressStream(compressStream(source))
```

`input` must be a WHATWG `ReadableStream`; wrap a Node `Readable` with `Readable.toWeb()`.

### Node Duplex factories

For ready-to-pipe Node streams, each namespace subpath exports `createCompressStream()` / `createDecompressStream()`, which return a Node [`Duplex`](https://nodejs.org/api/stream.html#class-streamduplex):

```js
import { createReadStream, createWriteStream } from 'node:fs'
import { createCompressStream } from '@napi-rs/lzma/xz'

createReadStream('input.txt').pipe(createCompressStream()).pipe(createWriteStream('input.txt.xz'))
```

### Backend & platform notes

- **Backend:** compression is powered by the pure-Rust [`lzma-rust2`](https://docs.rs/lzma-rust2) crate (previously `lzma-rs`). The one-shot API behavior is unchanged and the output remains standard, liblzma-compatible `.xz` / `.lzma`.
- **wasm / browser:** the incremental classes run natively on every target. The native tokio-backed `compressStream` / `decompressStream` transforms are compiled out of the wasm build, so under wasm the Web Streams API transparently falls back to a buffered polyfill (it drains the input, runs the class API, and emits a single chunk). The Node `Duplex` factories are Node-only and are not part of the browser entry.
- **lzma2 dictionary:** raw LZMA2 carries no dictionary size in-band, so it uses a fixed **8 MiB** dictionary by default. Override it via a symmetric `{ dictSize }` on **both** the compressor and the decompressor — they must agree. A decoder configured with a smaller dictionary than the encoder fails cleanly with an `InvalidArg` error; it never silently corrupts the output.
- **Trailing bytes:** as with the one-shot API, the `lzma` / `lzma2` stream decoders complete at the in-band end marker and ignore any trailing bytes after a complete frame; the `xz` decoder validates its framed trailer.

### Known limitation

Cancelling a Web `compressStream` / `decompressStream` **output** while a `read()` is still pending on a stalled or never-ending **input** can leak one worker thread until the process exits. Normal cancels — before reading, after data has flowed, or on any finite input — are unaffected. (Root cause: napi's stream cancel cannot interrupt a pull that is already in flight; a full fix needs an upstream napi cancel hook.)
