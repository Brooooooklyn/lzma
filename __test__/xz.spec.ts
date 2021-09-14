import test from 'ava'

import { compress, decompress } from '../xz'

let decompressNative: typeof import('lzma-native').decompress
let compressNative: typeof import('lzma-native').compress

try {
  const { decompress, compress } = require('lzma-native')
  decompressNative = decompress
  compressNative = compress
} catch {
  decompressNative = (buf, _opt, cb) => {
    decompress(Buffer.from(buf)).then(cb)
  }
  compressNative = (buf, _opt, cb) => {
    compress(Buffer.from(buf)).then(cb)
  }
}

const STRING_FIXTURE = 'Hello 🚀'

test('should be able to compress string', async (t) => {
  const output = await compress(STRING_FIXTURE)
  return new Promise<void>((resolve) => {
    decompressNative(output, 6, (o) => {
      t.is(o.toString('utf8'), STRING_FIXTURE)
      resolve()
    })
  })
})

test('should be able to decompress string', async (t) => {
  const compressed = await new Promise<Buffer>((resolve) => {
    compressNative(STRING_FIXTURE, 6, resolve)
  })

  t.is(await (await decompress(compressed)).toString('utf8'), STRING_FIXTURE)
})
