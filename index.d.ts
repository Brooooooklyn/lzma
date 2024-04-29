/* auto-generated by NAPI-RS */
/* eslint-disable */
export namespace lzma {
  export function compress(input: string | Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function compressSync(input: string | Buffer): Buffer
  export function decompress(input: Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompressSync(input: Buffer): Buffer
}

export namespace lzma2 {
  export function compress(input: string | Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function compressSync(input: string | Buffer): Buffer
  export function decompress(input: Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompressSync(input: Buffer): Buffer
}

export namespace xz {
  export function compress(input: string | Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function compressSync(input: string | Buffer): Buffer
  export function decompress(input: Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompressSync(input: Buffer): Buffer
}

