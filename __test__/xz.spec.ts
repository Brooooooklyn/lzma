import test from 'ava'
import { decompress as decompressNative, compress as compressNative } from 'lzma-native'

import { compress, decompress } from '../xz'

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
