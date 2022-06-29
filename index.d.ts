/* tslint:disable */
/* eslint-disable */

/* auto-generated by NAPI-RS */

export namespace lzma {
  export function compress(input: string | Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompress(input: Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
}
export namespace lzma2 {
  export function compress(input: string | Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompress(input: Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
}
export namespace xz {
  export function compress(input: string | Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
  export function decompress(input: Buffer, signal?: AbortSignal | undefined | null): Promise<Buffer>
}
