import { xz } from './index'

export const compress: typeof xz.compress
export const compressSync: typeof xz.compressSync
export const decompress: typeof xz.decompress
export const decompressSync: typeof xz.decompressSync
export const compressStream: typeof xz.compressStream
export const decompressStream: typeof xz.decompressStream

// Streaming classes, re-exported under the namespace-local names.
export { XzCompressor as Compressor, XzDecompressor as Decompressor } from './index'

/**
 * A ready-to-pipe Node `Duplex` that `.xz`-compresses everything written to it,
 * so `createReadStream().pipe(xz.createCompressStream()).pipe(dest)` works in one
 * call. Bridges the WHATWG `compressStream` transform internally.
 */
export function createCompressStream(options?: Parameters<typeof xz.compressStream>[1]): import('node:stream').Duplex
/**
 * A ready-to-pipe Node `Duplex` that decompresses an `.xz` byte stream written to
 * it. Bridges the WHATWG `decompressStream` transform internally.
 */
export function createDecompressStream(): import('node:stream').Duplex
