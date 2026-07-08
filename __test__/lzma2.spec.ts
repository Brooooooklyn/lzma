import { randomBytes } from 'node:crypto'

import test from 'ava'

import { compress, compressSync, decompress, decompressSync } from '../lzma2'

const STRING_FIXTURE = 'Hello 🚀'

// Deterministic low-entropy data (16-symbol alphabet) with variation, so it is
// compressible but still exercises the LZMA2 chunking / dictionary paths.
const lowEntropy = (size: number): Buffer => {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) {
    buf[i] = (Math.imul(i, 2654435761) >>> 24) & 0x0f
  }
  return buf
}

test('lzma2 async round-trip of a unicode string', async (t) => {
  const compressed = await compress(STRING_FIXTURE)
  const output = await decompress(compressed)
  t.is(output.toString('utf8'), STRING_FIXTURE)
})

test('lzma2 sync round-trip of a unicode string', (t) => {
  const compressed = compressSync(STRING_FIXTURE)
  const output = decompressSync(compressed)
  t.is(output.toString('utf8'), STRING_FIXTURE)
})

test('lzma2 cross: async compress -> sync decompress', async (t) => {
  const compressed = await compress(STRING_FIXTURE)
  const output = decompressSync(compressed)
  t.is(output.toString('utf8'), STRING_FIXTURE)
})

test('lzma2 cross: sync compress -> async decompress', async (t) => {
  const compressed = compressSync(STRING_FIXTURE)
  const output = await decompress(compressed)
  t.is(output.toString('utf8'), STRING_FIXTURE)
})

const FIXTURES: Array<{ name: string; data: Buffer }> = [
  { name: 'empty input', data: Buffer.alloc(0) },
  // > 2 MiB crosses the LZMA2 2 MiB uncompressed-chunk boundary.
  { name: '>2MB low-entropy', data: lowEntropy(2 * 1024 * 1024 + 7) },
  // > 8 MiB exercises the pinned 8 MiB dictionary window on decode (A10).
  { name: '>8MB low-entropy', data: lowEntropy(8 * 1024 * 1024 + 7) },
  { name: '>2MB incompressible random', data: randomBytes(2 * 1024 * 1024 + 7) },
  { name: 'highly repetitive', data: Buffer.alloc(3 * 1024 * 1024 + 5, 0x7a) },
]

for (const { name, data } of FIXTURES) {
  test(`lzma2 async round-trip: ${name}`, async (t) => {
    const compressed = await compress(data)
    const output = await decompress(compressed)
    t.deepEqual(Buffer.from(output), data)
  })

  test(`lzma2 sync round-trip: ${name}`, (t) => {
    const compressed = compressSync(data)
    const output = decompressSync(compressed)
    t.deepEqual(Buffer.from(output), data)
  })
}
