import { lzma } from './index'

export const compress: typeof lzma.compress
export const compressSync: typeof lzma.compressSync
export const decompress: typeof lzma.decompress
export const decompressSync: typeof lzma.decompressSync
export const compressStream: typeof lzma.compressStream
export const decompressStream: typeof lzma.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export { LzmaCompressor as Compressor, LzmaDecompressor as Decompressor } from './index'

/**
 * A ready-to-pipe Node `Duplex` that `.lzma`-compresses everything written to it,
 * so `createReadStream().pipe(lzma.createCompressStream()).pipe(dest)` works in
 * one call. Bridges the WHATWG `compressStream` transform internally.
 */
export function createCompressStream(options?: Parameters<typeof lzma.compressStream>[1]): import('node:stream').Duplex
/**
 * A ready-to-pipe Node `Duplex` that decompresses a `.lzma` byte stream written
 * to it. Bridges the WHATWG `decompressStream` transform internally.
 */
export function createDecompressStream(): import('node:stream').Duplex
