import { arch } from 'os'

import test from 'ava'
import type { Preset } from 'lzma-native'

import { compress, decompress } from '../lzma'

let decompressNative: ReturnType<typeof import('lzma-native').LZMA>['decompress']
let compressNative: ReturnType<typeof import('lzma-native').LZMA>['compress']

try {
  const LZMA = require('lzma-native').LZMA()
  decompressNative = LZMA.decompress
  compressNative = LZMA.compress
} catch {
  decompressNative = (buf, cb) => {
    decompress(Buffer.from(buf)).then(cb)
  }
  compressNative = (buf, _mode, cb) => {
    compress(Buffer.from(buf)).then(cb)
  }
}

const STRING_FIXTURE = 'Hello 🚀'

test('should be able to compress string', async (t) => {
  const output = await compress(STRING_FIXTURE)
  return new Promise<void>((resolve) => {
    decompressNative(output, (o) => {
      t.is(o.toString('utf8'), STRING_FIXTURE)
      resolve()
    })
  })
})

// lzma-native cause `Cannot allocate memory` error when mode is 8/9 on Windows x32 platform
for (const mode of Array.from({ length: arch() === 'ia32' ? 8 : 10 }).map((_, i) => i)) {
  test(`should be able to decompress string with mode ${mode}`, async (t) => {
    const compressed = await new Promise<Buffer>((resolve) => {
      compressNative(STRING_FIXTURE, mode as Preset, resolve)
    })
    t.is(await (await decompress(compressed)).toString('utf8'), STRING_FIXTURE)
  })
}
