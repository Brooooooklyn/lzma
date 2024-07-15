import {
  instantiateNapiModuleSync as __emnapiInstantiateNapiModuleSync,
  getDefaultContext as __emnapiGetDefaultContext,
  WASI as __WASI,
  createOnMessage as __wasmCreateOnMessageForFsProxy,
} from '@napi-rs/wasm-runtime'

import __wasmUrl from './lzma.wasm32-wasi.wasm?url'

const __wasi = new __WASI({
  version: 'preview1',
})

const __emnapiContext = __emnapiGetDefaultContext()

const __sharedMemory = new WebAssembly.Memory({
  initial: 4000,
  maximum: 65536,
  shared: true,
})

const __wasmFile = await fetch(__wasmUrl).then((res) => res.arrayBuffer())

const {
  instance: __napiInstance,
  module: __wasiModule,
  napiModule: __napiModule,
} = __emnapiInstantiateNapiModuleSync(__wasmFile, {
  context: __emnapiContext,
  asyncWorkPoolSize: 4,
  wasi: __wasi,
  onCreateWorker() {
    const worker = new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), {
      type: 'module',
    })
    
    return worker
  },
  overwriteImports(importObject) {
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory: __sharedMemory,
    }
    return importObject
  },
  beforeInit({ instance }) {
    __napi_rs_initialize_modules(instance)
  },
})

function __napi_rs_initialize_modules(__napiInstance) {
  __napiInstance.exports['__napi_register__Compress_impl_0']?.()
  __napiInstance.exports['__napi_register__compress_1']?.()
  __napiInstance.exports['__napi_register__compress_sync_2']?.()
  __napiInstance.exports['__napi_register__Decompress_impl_3']?.()
  __napiInstance.exports['__napi_register__decompress_4']?.()
  __napiInstance.exports['__napi_register__decompress_sync_5']?.()
  __napiInstance.exports['__napi_register__Compress_impl_6']?.()
  __napiInstance.exports['__napi_register__compress_7']?.()
  __napiInstance.exports['__napi_register__compress_sync_8']?.()
  __napiInstance.exports['__napi_register__Decompress_impl_9']?.()
  __napiInstance.exports['__napi_register__decompress_10']?.()
  __napiInstance.exports['__napi_register__decompress_sync_11']?.()
  __napiInstance.exports['__napi_register__Compress_impl_12']?.()
  __napiInstance.exports['__napi_register__compress_13']?.()
  __napiInstance.exports['__napi_register__compress_sync_14']?.()
  __napiInstance.exports['__napi_register__Decompress_impl_15']?.()
  __napiInstance.exports['__napi_register__decompress_16']?.()
  __napiInstance.exports['__napi_register__decompress_sync_17']?.()
}
export const lzma = __napiModule.exports.lzma
export const lzma2 = __napiModule.exports.lzma2
export const xz = __napiModule.exports.xz
