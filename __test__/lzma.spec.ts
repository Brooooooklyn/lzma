import { randomBytes } from 'node:crypto'
import { arch } from 'node:os'

import test from 'ava'
import type { Preset } from 'lzma-native'

import { compress, compressSync, decompress, decompressSync } from '../lzma'
import { IS_SLOW_EMULATED_ARCH, MAX_EMULATED_FIXTURE_BYTES } from './helpers'

let decompressNative: ReturnType<typeof import('lzma-native').LZMA>['decompress']
let compressNative: ReturnType<typeof import('lzma-native').LZMA>['compress']

const decompressPolyfill = (buf: string | Buffer, cb?: (output: Buffer) => void) => {
  decompress(Buffer.from(buf)).then(cb)
}

try {
  const LZMA = require('lzma-native').LZMA()
  decompressNative = LZMA.decompress
  compressNative = LZMA.compress
} catch {
  decompressNative = decompressPolyfill
  compressNative = (buf, _mode, cb) => {
    compress(Buffer.from(buf)).then(cb)
  }
}

const STRING_FIXTURE = 'Hello 🚀'

test('should be able to compress string', async (t) => {
  const output = await compress(STRING_FIXTURE)
  return new Promise<void>((resolve) => {
    ;(process.env.NAPI_RS_FORCE_WASI ? decompressPolyfill : decompressNative)(output, (o) => {
      t.is(o.toString('utf8'), STRING_FIXTURE)
      resolve()
    })
  })
})

// lzma-native cause `Cannot allocate memory` error when mode is 7/8/9 on Windows x32 platform
for (const mode of Array.from({ length: arch() === 'ia32' ? 7 : 10 }).map((_, i) => i)) {
  test(`should be able to decompress string with mode ${mode}`, async (t) => {
    const compressed = await new Promise<Buffer>((resolve) => {
      compressNative(STRING_FIXTURE, mode as Preset, resolve)
    })
    t.is(await (await decompress(compressed)).toString('utf8'), STRING_FIXTURE)
  })
}

// Deterministic low-entropy data (16-symbol alphabet) with variation.
const lowEntropy = (size: number): Buffer => {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) {
    buf[i] = (Math.imul(i, 2654435761) >>> 24) & 0x0f
  }
  return buf
}

const nativeDecompress = (buf: Buffer): Promise<Buffer> =>
  new Promise((resolve) => {
    ;(process.env.NAPI_RS_FORCE_WASI ? decompressPolyfill : decompressNative)(buf, (o) => resolve(o))
  })

const nativeCompress = (buf: Buffer): Promise<Buffer> =>
  new Promise((resolve) => {
    compressNative(buf, 6 as Preset, (o) => resolve(o))
  })

const FIXTURES: Array<{ name: string; data: Buffer }> = [
  { name: 'empty input', data: Buffer.alloc(0) },
  { name: '>2MB low-entropy', data: lowEntropy(2 * 1024 * 1024 + 7) },
  { name: '>8MB low-entropy', data: lowEntropy(8 * 1024 * 1024 + 7) },
  { name: '>2MB incompressible random', data: randomBytes(2 * 1024 * 1024 + 7) },
  { name: 'highly repetitive', data: Buffer.alloc(3 * 1024 * 1024 + 5, 0x61) },
]

for (const { name, data } of FIXTURES) {
  // Fixtures > 4 MiB (the >8MB one) are an HONEST skip on the QEMU-emulated
  // s390x/ppc64le legs — they exceed ava's timeout under emulation and the failure
  // is swallowed by `continue-on-error` — while still running on every native arch.
  const tooBigForEmulated = IS_SLOW_EMULATED_ARCH && data.length > MAX_EMULATED_FIXTURE_BYTES
  const rt = tooBigForEmulated ? test.skip : test
  const suffix = tooBigForEmulated ? ' [>4MB: skipped on emulated s390x/ppc64le]' : ''

  rt(`lzma async round-trip: ${name}${suffix}`, async (t) => {
    const output = await decompress(await compress(data))
    t.deepEqual(Buffer.from(output), data)
  })

  rt(`lzma sync round-trip: ${name}${suffix}`, (t) => {
    const output = decompressSync(compressSync(data))
    t.deepEqual(Buffer.from(output), data)
  })

  // our compress -> lzma-native decompress (self round-trip when lzma-native is absent)
  rt(`lzma cross-compat, ours -> native: ${name}${suffix}`, async (t) => {
    const output = await nativeDecompress(await compress(data))
    t.deepEqual(Buffer.from(output), data)
  })

  // lzma-native compress -> our decompress (self round-trip when lzma-native is absent)
  rt(`lzma cross-compat, native -> ours: ${name}${suffix}`, async (t) => {
    const output = await decompress(await nativeCompress(data))
    t.deepEqual(Buffer.from(output), data)
  })
}
