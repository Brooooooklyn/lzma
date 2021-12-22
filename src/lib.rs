#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

macro_rules! define_functions {
  ($namespace:expr, $compress_algorithm:ident, $decompress_algorithm:ident) => {
    use std::convert::TryFrom;

    use napi::{bindgen_prelude::*, JsBuffer, JsBufferValue, Ref};

    enum AsyncTaskData {
      Buffer(Ref<JsBufferValue>),
      String(String),
    }

    impl AsyncTaskData {
      pub fn unref(&mut self, env: Env) -> Result<()> {
        match self {
          AsyncTaskData::Buffer(buffer) => buffer.unref(env).map(|_| ()),
          AsyncTaskData::String(_) => Ok(()),
        }
      }
    }

    impl AsRef<[u8]> for AsyncTaskData {
      fn as_ref(&self) -> &[u8] {
        match &self {
          AsyncTaskData::Buffer(buffer) => buffer.as_ref(),
          AsyncTaskData::String(string) => string.as_bytes(),
        }
      }
    }

    impl TryFrom<Either<String, JsBuffer>> for AsyncTaskData {
      type Error = Error;

      fn try_from(value: Either<String, JsBuffer>) -> Result<Self> {
        Ok(match value {
          Either::A(string) => AsyncTaskData::String(string),
          Either::B(buffer) => AsyncTaskData::Buffer(buffer.into_ref()?),
        })
      }
    }

    #[repr(transparent)]
    pub struct Compress(AsyncTaskData);

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

      fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Buffer> {
        Ok(output.into())
      }

      fn finally(&mut self, env: Env) -> Result<()> {
        self.0.unref(env)?;
        Ok(())
      }
    }

    #[napi(namespace = $namespace)]
    pub fn compress(
      input: Either<String, JsBuffer>,
      signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Compress>> {
      Ok(AsyncTask::with_optional_signal(
        Compress(AsyncTaskData::try_from(input)?),
        signal,
      ))
    }

    #[repr(transparent)]
    pub struct Decompress(Ref<JsBufferValue>);

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

      fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Buffer> {
        Ok(output.into())
      }

      fn finally(&mut self, env: Env) -> Result<()> {
        self.0.unref(env)?;
        Ok(())
      }
    }

    #[napi(namespace = $namespace)]
    pub fn decompress(
      input: JsBuffer,
      signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<Decompress>> {
      Ok(AsyncTask::with_optional_signal(
        Decompress(input.into_ref()?),
        signal,
      ))
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
