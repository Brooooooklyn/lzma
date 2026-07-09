/**
 * Buffer-free guard for the browser-shared stream polyfill (`stream-polyfill.mjs`).
 *
 * `stream-polyfill.mjs` is imported directly by every browser wrapper
 * (`browser-entry.js`, `xz.browser.js`, `lzma.browser.js`, `lzma2.browser.js`) and
 * consumed by the Node CJS wrappers via `require(esm)`. A real browser — and the
 * `@napi-rs/wasm-runtime` binding the wasm build ships — defines NO `Buffer`
 * global, so any `Buffer.*` in that module makes a browser consumer that calls
 * `compressStream` / `decompressStream` throw `Buffer is not defined` on the first
 * stream `pull`.
 *
 * The in-process ava worker always has `Buffer`, so this exercises the module in a
 * child `node` process (bare — no ava/@oxc-node loader) that deletes
 * `globalThis.Buffer`, forces the buffered class-API polyfill, and round-trips
 * `compressStream` → `decompressStream`. It runs on every target (native or wasm):
 * the polyfill helper code under test is identical, and the classes exist on both.
 *
 * RED/GREEN: reverting just the `.mjs` `Buffer` → `Uint8Array` change makes the
 * child exit non-zero with `Buffer is not defined` on stderr.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import test from 'ava'

const execFileAsync = promisify(execFile)

const PROBE = fileURLToPath(new URL('./buffer-free-probe.mjs', import.meta.url))

test('browser stream polyfill round-trips with no Buffer global (Buffer-free)', async (t) => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [PROBE], {
    // Fail fast rather than hang if the polyfill ever deadlocks.
    timeout: 60_000,
    encoding: 'utf8',
  })
  t.false(/Buffer is not defined/.test(stderr), `child stderr referenced a missing Buffer:\n${stderr}`)
  t.true(
    stdout.includes('BUFFER_FREE_PROBE_OK'),
    `probe did not confirm a Buffer-free round-trip.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  )
})
