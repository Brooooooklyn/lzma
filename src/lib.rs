#![deny(clippy::all)]

mod backend;
mod stream;

#[cfg(all(
  not(target_arch = "x86"),
  not(target_arch = "arm"),
  not(target_family = "wasm")
))]
#[global_allocator]
static ALLOC: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

macro_rules! define_functions {
  ($namespace:expr, $compress_algorithm:ident, $decompress_algorithm:ident) => {
    use napi::{ScopedTask, bindgen_prelude::*};

    #[repr(transparent)]
    pub struct Compress(Either<String, Uint8Array>);

    #[napi_derive::napi(namespace = $namespace)]
    impl<'task> ScopedTask<'task> for Compress {
      type Output = Vec<u8>;
      type JsValue = BufferSlice<'task>;

      fn compute(&mut self) -> Result<Self::Output> {
        crate::backend::$compress_algorithm(self.0.as_ref()).map_err(crate::backend::map_io)
      }

      fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        BufferSlice::from_data(env, output)
      }

      fn finally(mut self, _: Env) -> Result<()> {
        if let Either::B(buffer) = &mut self.0 {
          std::mem::drop(std::mem::replace(buffer, Uint8Array::from(vec![])));
        }
        Ok(())
      }
    }

    #[napi_derive::napi(namespace = $namespace)]
    pub fn compress(
      input: Either<String, Uint8Array>,
      signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Compress>> {
      Ok(AsyncTask::with_optional_signal(Compress(input), signal))
    }

    #[napi_derive::napi(namespace = $namespace)]
    pub fn compress_sync(input: Either<String, Uint8Array>) -> Result<Buffer> {
      let output =
        crate::backend::$compress_algorithm(input.as_ref()).map_err(crate::backend::map_io)?;
      Ok(output.into())
    }

    #[repr(transparent)]
    pub struct Decompress(Uint8Array);

    #[napi_derive::napi(namespace = $namespace)]
    impl<'task> ScopedTask<'task> for Decompress {
      type Output = Vec<u8>;
      type JsValue = BufferSlice<'task>;

      fn compute(&mut self) -> Result<Self::Output> {
        crate::backend::$decompress_algorithm(self.0.as_ref()).map_err(crate::backend::map_invalid)
      }

      fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        BufferSlice::from_data(env, output)
      }

      fn finally(mut self, _: Env) -> Result<()> {
        std::mem::drop(std::mem::replace(&mut self.0, Uint8Array::from(vec![])));
        Ok(())
      }
    }

    #[napi_derive::napi(namespace = $namespace)]
    pub fn decompress(
      input: Uint8Array,
      signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Decompress>> {
      Ok(AsyncTask::with_optional_signal(Decompress(input), signal))
    }

    #[napi_derive::napi(namespace = $namespace)]
    pub fn decompress_sync(input: &[u8]) -> Result<Buffer> {
      let output =
        crate::backend::$decompress_algorithm(input).map_err(crate::backend::map_invalid)?;
      Ok(output.into())
    }
  };
}

pub mod lzma {
  define_functions!("lzma", lzma_compress, lzma_decompress);
}

pub mod lzma2 {
  define_functions!("lzma2", lzma2_compress, lzma2_decompress);
}

pub mod xz {
  define_functions!("xz", xz_compress, xz_decompress);
}
