/* auto-generated by NAPI-RS */
/* eslint-disable */
export declare namespace lzma {
  export function compress(input: string | Uint8Array, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function compressSync(input: string | Uint8Array): Buffer
  export function decompress(input: Uint8Array, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompressSync(input: Uint8Array): Buffer
}

export declare namespace lzma2 {
  export function compress(input: string | Uint8Array, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function compressSync(input: string | Uint8Array): Buffer
  export function decompress(input: Uint8Array, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompressSync(input: Uint8Array): Buffer
}

export declare namespace xz {
  export function compress(input: string | Uint8Array, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function compressSync(input: string | Uint8Array): Buffer
  export function decompress(input: Uint8Array, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompressSync(input: Uint8Array): Buffer
}

