#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use napi::{CallContext, Env, JsBuffer, JsBufferValue, JsObject, Ref, Result, Task};

#[module_exports]
fn init(mut exports: JsObject) -> Result<()> {
  exports.create_named_method("compress", compress)?;
  exports.create_named_method("decompress", decompress)?;
  Ok(())
}

#[repr(transparent)]
struct Compress(Ref<JsBufferValue>);

impl Task for Compress {
  type Output = Vec<u8>;
  type JsValue = JsBuffer;

  fn compute(&mut self) -> Result<Self::Output> {
    let mut data_ref = self.0.as_ref();
    let mut output = Vec::new();
    lzma_rs::xz_compress(&mut data_ref, &mut output)?;
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
fn compress(ctx: CallContext) -> Result<JsObject> {
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
    lzma_rs::xz_decompress(&mut data_ref, &mut output)
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
fn decompress(ctx: CallContext) -> Result<JsObject> {
  let input = ctx.get::<JsBuffer>(0)?.into_ref()?;
  ctx.env.spawn(Decompress(input)).map(|p| p.promise_object())
}
