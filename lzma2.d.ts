import { lzma2 } from './index'

export const compress: typeof lzma2.compress
export const compressSync: typeof lzma2.compressSync
export const decompress: typeof lzma2.decompress
export const decompressSync: typeof lzma2.decompressSync
export const compressStream: typeof lzma2.compressStream
export const decompressStream: typeof lzma2.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export { Lzma2Compressor as Compressor, Lzma2Decompressor as Decompressor } from './index'

/**
 * A ready-to-pipe Node `Duplex` that raw-LZMA2-compresses everything written to
 * it, so `createReadStream().pipe(lzma2.createCompressStream()).pipe(dest)` works
 * in one call. Bridges the WHATWG `compressStream` transform internally.
 */
export function createCompressStream(options?: Parameters<typeof lzma2.compressStream>[1]): import('node:stream').Duplex
/**
 * A ready-to-pipe Node `Duplex` that decompresses a raw LZMA2 byte stream written
 * to it. `options.dictSize` must match the encoder (raw LZMA2 carries none
 * in-band). Bridges the WHATWG `decompressStream` transform internally.
 */
export function createDecompressStream(
  options?: Parameters<typeof lzma2.decompressStream>[1],
): import('node:stream').Duplex
