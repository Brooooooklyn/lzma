#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

#[cfg(all(
  not(target_arch = "x86"),
  not(target_arch = "arm"),
  not(target_family = "wasm")
))]
#[global_allocator]
static ALLOC: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

macro_rules! define_functions {
  ($namespace:expr, $compress_algorithm:ident, $decompress_algorithm:ident) => {
    use napi::bindgen_prelude::*;

    #[repr(transparent)]
    pub struct Compress(Either<String, Uint8Array>);

    #[napi(namespace = $namespace)]
    impl Task for Compress {
      type Output = Vec<u8>;
      type JsValue = Buffer;

      fn compute(&mut self) -> Result<Self::Output> {
        let mut data_ref = self.0.as_ref();
        let mut output = Vec::new();
        lzma_rs::$compress_algorithm(&mut data_ref, &mut output)?;
        Ok(output)
      }

      fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Buffer> {
        Ok(output.into())
      }

      fn finally(mut self, _: Env) -> Result<()> {
        if let Either::B(buffer) = &mut self.0 {
          std::mem::drop(std::mem::replace(buffer, Uint8Array::from(vec![])));
        }
        Ok(())
      }
    }

    #[napi(namespace = $namespace)]
    pub fn compress(
      input: Either<String, Uint8Array>,
      signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Compress>> {
      Ok(AsyncTask::with_optional_signal(Compress(input), signal))
    }

    #[napi(namespace = $namespace)]
    pub fn compress_sync(input: Either<String, Uint8Array>) -> Result<Buffer> {
      let mut output = Vec::with_capacity(input.as_ref().len());
      lzma_rs::$compress_algorithm(&mut input.as_ref(), &mut output)?;
      Ok(output.into())
    }

    #[repr(transparent)]
    pub struct Decompress(Uint8Array);

    #[napi(namespace = $namespace)]
    impl Task for Decompress {
      type Output = Vec<u8>;
      type JsValue = Buffer;

      fn compute(&mut self) -> Result<Self::Output> {
        let mut data_ref = self.0.as_ref();
        let mut output = Vec::new();
        lzma_rs::$decompress_algorithm(&mut data_ref, &mut output)
          .map_err(|err| napi::Error::new(napi::Status::InvalidArg, format!("{}", err)))?;
        Ok(output)
      }

      fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Buffer> {
        Ok(output.into())
      }

      fn finally(mut self, _: Env) -> Result<()> {
        std::mem::drop(std::mem::replace(&mut self.0, Uint8Array::from(vec![])));
        Ok(())
      }
    }

    #[napi(namespace = $namespace)]
    pub fn decompress(
      input: Uint8Array,
      signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Decompress>> {
      Ok(AsyncTask::with_optional_signal(Decompress(input), signal))
    }

    #[napi(namespace = $namespace)]
    pub fn decompress_sync(mut input: &[u8]) -> Result<Buffer> {
      let mut output = Vec::with_capacity(input.len());
      lzma_rs::$decompress_algorithm(&mut input, &mut output)
        .map_err(|err| napi::Error::new(napi::Status::InvalidArg, format!("{}", err)))?;
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
