#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use napi::{JsObject, Result};

#[module_exports]
fn init(mut exports: JsObject) -> Result<()> {
  exports.create_named_method("xzCompress", xz::compress)?;
  exports.create_named_method("xzDecompress", xz::decompress)?;

  exports.create_named_method("lzmaCompress", lzma::compress)?;
  exports.create_named_method("lzmaDecompress", lzma::decompress)?;

  exports.create_named_method("lzma2Compress", lzma2::compress)?;
  exports.create_named_method("lzma2Decompress", lzma2::decompress)?;
  Ok(())
}

macro_rules! define_functions {
  ($compress_algorithm:ident, $decompress_algorithm:ident) => {
    use napi::*;
    #[repr(transparent)]
    struct Compress(Ref<JsBufferValue>);

    impl Task for Compress {
      type Output = Vec<u8>;
      type JsValue = JsBuffer;

      fn compute(&mut self) -> Result<Self::Output> {
        let mut data_ref = self.0.as_ref();
        let mut output = Vec::new();
        lzma_rs::$compress_algorithm(&mut data_ref, &mut output)?;
        Ok(output)
      }

      fn resolve(self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.0.unref(env)?;
        env.create_buffer_with_data(output).map(|b| b.into_raw())
      }

      fn reject(self, env: Env, err: napi::Error) -> Result<Self::JsValue> {
        self.0.unref(env)?;
        Err(err)
      }
    }

    #[js_function(1)]
    pub fn compress(ctx: CallContext) -> Result<JsObject> {
      let input = ctx.get::<JsBuffer>(0)?.into_ref()?;
      ctx.env.spawn(Compress(input)).map(|p| p.promise_object())
    }

    #[repr(transparent)]
    struct Decompress(Ref<JsBufferValue>);

    impl Task for Decompress {
      type Output = Vec<u8>;
      type JsValue = JsBuffer;

      fn compute(&mut self) -> Result<Self::Output> {
        let mut data_ref = self.0.as_ref();
        let mut output = Vec::new();
        lzma_rs::$decompress_algorithm(&mut data_ref, &mut output)
          .map_err(|err| napi::Error::new(napi::Status::InvalidArg, format!("{}", err)))?;
        Ok(output)
      }

      fn resolve(self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.0.unref(env)?;
        env.create_buffer_with_data(output).map(|b| b.into_raw())
      }

      fn reject(self, env: Env, err: napi::Error) -> Result<Self::JsValue> {
        self.0.unref(env)?;
        Err(err)
      }
    }

    #[js_function(1)]
    pub fn decompress(ctx: CallContext) -> Result<JsObject> {
      let input = ctx.get::<JsBuffer>(0)?.into_ref()?;
      ctx.env.spawn(Decompress(input)).map(|p| p.promise_object())
    }
  };
}

mod lzma {
  define_functions!(lzma_compress, lzma_decompress);
}

mod lzma2 {
  define_functions!(lzma2_compress, lzma2_decompress);
}

mod xz {
  define_functions!(xz_compress, xz_decompress);
}
