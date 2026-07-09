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

|                       | node14 | node16 | node18 | node20 |
| --------------------- | ------ | ------ | ------ | ------ |
| Windows x64           | ✓      | ✓      | ✓      | ✓      |
| Windows x32           | ✓      | ✓      | ✓      | ✓      |
| Windows arm64         | ✓      | ✓      | ✓      | ✓      |
| macOS x64             | ✓      | ✓      | ✓      | ✓      |
| macOS arm64 (m chips) | ✓      | ✓      | ✓      | ✓      |
| Linux x64 gnu         | ✓      | ✓      | ✓      | ✓      |
| Linux x64 musl        | ✓      | ✓      | ✓      | ✓      |
| Linux arm gnu         | ✓      | ✓      | ✓      | ✓      |
| Linux arm64 gnu       | ✓      | ✓      | ✓      | ✓      |
| Linux arm64 musl      | ✓      | ✓      | ✓      | ✓      |
| Android arm64         | ✓      | ✓      | ✓      | ✓      |
| Android armv7         | ✓      | ✓      | ✓      | ✓      |
| FreeBSD x64           | ✓      | ✓      | ✓      | ✓      |

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
