/**
 * Convenience Node-stream factories (T5): `createCompressStream()` /
 * `createDecompressStream()` on each subpath entry return a ready-to-pipe Node
 * `Duplex` bridging the WHATWG web-stream transforms, so the common
 * `createReadStream().pipe(xz.createCompressStream()).pipe(dest)` case is one
 * call. These work on every target: a native tokio transform where present, the
 * buffered class-API polyfill otherwise — so they are NOT gated on the native fn.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import test from 'ava'

import * as lzmaSub from '../lzma'
import * as lzma2Sub from '../lzma2'
import * as xzSub from '../xz'
import { chunkBySize, oneShot, type Namespace } from './helpers'

interface FactoryApi {
  createCompressStream: (options?: unknown) => Duplex
  createDecompressStream: (options?: unknown) => Duplex
  Compressor: unknown
  Decompressor: unknown
}

const FACTORY: Record<Namespace, FactoryApi> = {
  lzma: lzmaSub as unknown as FactoryApi,
  lzma2: lzma2Sub as unknown as FactoryApi,
  xz: xzSub as unknown as FactoryApi,
}

const NAMESPACES: readonly Namespace[] = ['lzma', 'lzma2', 'xz']

const INPUT = Buffer.from('Node-stream factory 🚀 lzma bridge '.repeat(4096), 'utf8')

/** Async-iterate a readable Node stream into a single Buffer. */
const collect = async (readable: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

// ── 1) Duplex round-trip: pipe plaintext → compress duplex → decompress duplex ─
for (const ns of NAMESPACES) {
  test(`${ns}: createCompressStream → createDecompressStream round-trips (piped, multi-chunk)`, async (t) => {
    const { createCompressStream, createDecompressStream } = FACTORY[ns]
    const compressed = await collect(Readable.from(chunkBySize(INPUT, 64 * 1024)).pipe(createCompressStream()))
    const restored = await collect(Readable.from(chunkBySize(compressed, 4096)).pipe(createDecompressStream()))
    t.deepEqual(restored, INPUT)
  })
}

// ── 2) Factory output is interoperable with the trusted one-shot decoder ───────
for (const ns of NAMESPACES) {
  test(`${ns}: createCompressStream output decodes via the one-shot oracle`, async (t) => {
    const { createCompressStream } = FACTORY[ns]
    const compressed = await collect(Readable.from([INPUT]).pipe(createCompressStream()))
    const restored = await oneShot(ns).decompress(compressed)
    t.deepEqual(Buffer.from(restored), INPUT)
  })

  test(`${ns}: createDecompressStream decodes a one-shot-compressed stream`, async (t) => {
    const { createDecompressStream } = FACTORY[ns]
    const compressed = Buffer.from(await oneShot(ns).compress(INPUT))
    const restored = await collect(Readable.from(chunkBySize(compressed, 7)).pipe(createDecompressStream()))
    t.deepEqual(restored, INPUT)
  })
}

// ── 3) The headline use case end-to-end: file → compress → file → decompress ───
// Proves `fs.createReadStream().pipe(createCompressStream()).pipe(createWriteStream())`
// works in one call, through `stream.pipeline` (full error + cleanup handling).
test('xz: fs.createReadStream → createCompressStream → createDecompressStream → file round-trips', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lzma-factory-'))
  t.teardown(() => rm(dir, { recursive: true, force: true }))
  const srcPath = join(dir, 'input.bin')
  const xzPath = join(dir, 'output.xz')
  const outPath = join(dir, 'restored.bin')
  await writeFile(srcPath, INPUT)

  await pipeline(createReadStream(srcPath), xzSub.createCompressStream(), createWriteStream(xzPath))
  await pipeline(createReadStream(xzPath), xzSub.createDecompressStream(), createWriteStream(outPath))

  t.deepEqual(await readFile(outPath), INPUT)
})

// ── 4) lzma2 factory threads dictSize through both directions ──────────────────
test('lzma2: createCompressStream/createDecompressStream honour an explicit dictSize', async (t) => {
  const dictSize = 8 << 20
  const compressed = await collect(
    Readable.from(chunkBySize(INPUT, 64 * 1024)).pipe(lzma2Sub.createCompressStream({ dictSize })),
  )
  const restored = await collect(
    Readable.from(chunkBySize(compressed, 4096)).pipe(lzma2Sub.createDecompressStream({ dictSize })),
  )
  t.deepEqual(restored, INPUT)
})
