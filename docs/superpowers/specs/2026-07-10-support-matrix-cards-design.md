# Support matrix cards — design

Date: 2026-07-10
Status: approved, ready for planning

## Problem

`README.md:17-33` renders the support matrix as a 13-row × 4-column checkmark table with
columns `node14 | node16 | node18 | node20`. Three things are wrong with it:

1. **Every node column is false.** `package.json:84-86` declares
   `engines.node = "^22.20 || ^24.12 || >=25"`. All four advertised versions sit *below*
   the supported floor. None are tested.
2. **Four shipped targets are absent:** `riscv64gc-unknown-linux-gnu`,
   `powerpc64le-unknown-linux-gnu`, `s390x-unknown-linux-gnu`, and
   `wasm32-wasi-preview1-threads` (the entire browser story).
3. **The uniform `✓` overclaims.** Four targets are built and published but never
   exercised in CI; two more are tested with `continue-on-error`.

Separately, the browser build requires `SharedArrayBuffer` — `lzma.wasi-browser.js:18-22`
constructs `new WebAssembly.Memory({ shared: true })` and `wasi-worker-browser.mjs` spawns
module workers against it. That means the consuming page must be **cross-origin isolated**
(`COOP: same-origin` + `COEP: require-corp`). This requirement is documented nowhere in the
repository.

## Goal

Replace the table with three visual cards in the style of the reference screenshot, backed
by an accessible text fallback, and correct every factual claim in the process.

## Rendering constraints (verified, not assumed)

| Constraint | Verdict | Consequence |
|---|---|---|
| `style` / `class` attrs, `<style>` blocks in README | stripped by GitHub's sanitizer | cards cannot be raw HTML |
| inline `<svg>…</svg>` in README | stripped | must reference a committed `.svg` file |
| `<img src="./x.svg">` on a committed SVG | served **verbatim**; gradients, internal `<style>`, `rx`, `<text>` all preserved | this is the mechanism |
| self-theming SVG via internal `@media (prefers-color-scheme)` | keys off the **OS**, not GitHub's theme toggle | unusable; needs two files |
| `<picture>` + `prefers-color-scheme` | GA on GitHub since 2022-08-15; also honored by npmjs.com | this is the theming mechanism |
| `@font-face` / web fonts inside `<img>`-embedded SVG | never load (CSP `default-src 'none'`) | system font stack only |
| relative image paths on npmjs.com | rewritten to `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` when `repository` is set | `./assets/…` is safe on both surfaces |

`width` is an allowed attribute on `<img>`; `style` is not.

## Ground truth

### Node.js

`engines.node = "^22.20 || ^24.12 || >=25"` — a **non-contiguous** range.

- Supported: `22.20 – 22.x`, `24.12 – 24.x`, `25` and every later major.
- Excluded: all of `23.x`, and `24.0 – 24.11`.
- CI tests node **22** and **24** only (`CI.yml:254-256`, `CI.yml:298-300`).

The floor comes from the JS layer, not the binding: `main.js:19-21` relies on
`require(ESM)` for `stream-polyfill.mjs`. The Rust crate only requests `napi5`
(`Cargo.toml:28`), i.e. Node-API 5. **Do not claim the package requires Node-API 9.**

### Node release status as of 2026-07-10

Taken from `nodejs/Release/schedule.json`, not from memory. A major is Active LTS between
its `lts` and `maintenance` dates; Current between `start` and `lts`.

| Major | `lts` | `maintenance` | `eol` | Status today | Permitted by `engines`? |
|---|---|---|---|---|---|
| v20 | 2023-10-24 | 2024-10-22 | **2026-04-30** | EOL | no |
| v22 | 2024-10-29 | **2025-10-21** | 2027-04-30 | **Maintenance LTS** | yes (≥22.20) |
| v23 | — | 2025-04-01 | 2025-06-01 | EOL | no |
| v24 | **2025-10-28** | 2026-10-20 | 2028-04-30 | **Active LTS** | yes (≥24.12) |
| v25 | — | 2026-04-01 | **2026-06-01** | **EOL** | yes (`>=25`) |
| v26 | 2026-10-28 | 2027-10-20 | 2029-04-30 | **Current** | yes (`>=25`) |
| v27 | — | — | — | not yet released (starts 2027-04-22) | yes (`>=25`) |

Two corrections this forces on the card:

1. **"Active LTS & Current" is wrong.** Node 22 is in *Maintenance* LTS, not Active. Only
   v24 is Active LTS; v26 is Current.
2. **Do not show a `25` pill.** `engines` permits v25, but it reached EOL on 2026-06-01.
   Advertising it on the card steers users onto an unsupported runtime. The exact `engines`
   string is reproduced verbatim in the `<details>` table, so nothing is concealed.

### Targets — three tiers, 17 total

Tier definitions:

- **green — CI-tested.** A failure blocks the build.
- **amber — non-blocking.** Runs under `continue-on-error`.
- **grey — built, untested.** Compiled and published; no CI coverage.

The `continue-on-error` expression at `CI.yml:355` is
`contains(matrix.target,'powerpc64') || contains(matrix.target,'s390x')` — so amber has
exactly two members. `armv7` is blocking despite its reduced node coverage.

| Tier | Rust triple | Card label | Tested |
|---|---|---|---|
| green | `x86_64-pc-windows-msvc` | Windows x64 | node 22, 24 |
| green | `aarch64-pc-windows-msvc` | Windows arm64 | node 22, 24 |
| green | `i686-pc-windows-msvc` | Windows x32 | node 22 x86 only, `--serial` |
| green | `x86_64-apple-darwin` | macOS x64 | node 22, 24 |
| green | `aarch64-apple-darwin` | macOS arm64 | node 22, 24 |
| green | `x86_64-unknown-linux-gnu` | Linux x64 gnu | node 22, 24 |
| green | `x86_64-unknown-linux-musl` | Linux x64 musl | node 22, 24 |
| green | `aarch64-unknown-linux-gnu` | Linux arm64 gnu | node 22, 24 |
| green | `aarch64-unknown-linux-musl` | Linux arm64 musl | node 22, 24 |
| green | `armv7-unknown-linux-gnueabihf` | Linux armv7 gnu | node 22 only, `--serial` |
| green | `x86_64-unknown-freebsd` | FreeBSD x64 | node unpinned (`pkg install node`) |
| amber | `powerpc64le-unknown-linux-gnu` | Linux ppc64le | node 22, 24 — non-blocking |
| amber | `s390x-unknown-linux-gnu` | Linux s390x | node 22, 24 — non-blocking |
| grey | `riscv64gc-unknown-linux-gnu` | Linux riscv64 | never |
| grey | `aarch64-linux-android` | Android arm64 | never |
| grey | `arm-linux-androideabi` | Android armv7 | never |
| grey | `wasm32-wasi-preview1-threads` | wasm32-wasi | never |

Counts: 11 green + 2 amber + 4 grey = **17**, matching `package.json:7-25`.

Two `package.json` ↔ CI spellings differ but are napi-rs aliases for the same artifact,
confirmed against `@napi-rs/cli`'s `parseTriple`:
`arm-linux-androideabi` ≡ `armv7-linux-androideabi` → `@napi-rs/lzma-android-arm-eabi`;
`wasm32-wasi-preview1-threads` ≡ `wasm32-wasip1-threads` → `@napi-rs/lzma-wasm32-wasi`.
Not a bug; do not "fix" either file.

The generated root `index.js` also `require`s `darwin-universal`, `freebsd-arm64`,
`linux-arm-musleabihf`, `linux-riscv64-musl`, and three `openharmony-*` packages. None are
in `napi.targets`, so none are published. **Do not list them as supported.**

## Deliverables

### Files

```
assets/
  support-node-light.svg       support-node-dark.svg
  support-platforms-light.svg  support-platforms-dark.svg
  support-browser-light.svg    support-browser-dark.svg
```

Hand-written. Not added to `package.json` `files` — the tarball stays lean, and npm resolves
the relative path against `raw.githubusercontent.com` regardless.

### README markup

Per card, dark `<source>` first, light `<img>` as fallback:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/support-node-dark.svg">
  <img alt="Node.js — v22.20 → v26. Maintenance LTS 22, Active LTS 24, Current 26. Node 23 and 24.0–24.11 excluded." src="./assets/support-node-light.svg" width="880">
</picture>
```

Followed by a `<details><summary>Full matrix as text</summary>` block containing a real
markdown table (triple, label, tier, tested-on). This restores Ctrl+F and screen-reader
access, which an image cannot provide.

### Card content

**Node.js** — headline `v22.20 → v26`. The arrow implies contiguity, so the subtitle must
carry the holes and the real release status: *"Maintenance LTS 22 · Active LTS 24 · Current
26. Node 23 and 24.0–24.11 are excluded by `engines`."* Pills: `22.20+` green, `24.12+`
green, `26` grey. **No `25` pill** — EOL 2026-06-01.

Pill colors mean the same thing on every card: **green = exercised in CI**, **grey = allowed
and shipped, but not covered by CI**. So `26` is grey because `engines` permits it while the
test matrix only runs 22 and 24 — not because it is second-class.

**Platforms** — headline `16 native targets, prebuilt`. Subtitle *"No node-gyp, no
toolchain, no postinstall step."* Pills grouped by OS: Linux (8), Windows (3), macOS (2),
Android (2), FreeBSD (1). Legend row: `● CI-tested  ● non-blocking  ● built, untested`.

**Browser** — headline `wasm32-wasi`, grey tier. Subtitle *"Bundlers pick the wasm build via
the `browser` export condition."* A warning line: *"Requires cross-origin isolation (COOP +
COEP) for SharedArrayBuffer."*

The platforms card says **16 native**; the browser card carries the 17th (wasm). The
`<details>` table states the full 17.

### Tokens

GitHub's own palette, so the cards sit *in* the page rather than on it.

| Token | Light | Dark |
|---|---|---|
| canvas | `#ffffff` | `#0d1117` |
| border | `#d0d7de` | `#30363d` |
| heading | `#1f2328` | `#e6edf3` |
| muted | `#59636e` | `#8b949e` |
| green | `#1a7f37` on `#dafbe1` | `#7ee787` on `rgba(63,185,80,.15)` |
| amber | `#7d4e00` on `#fff8c5` | `#e3b341` on `rgba(210,153,34,.15)` |
| grey | `#59636e` on `#f6f8fa` | `#8b949e` on `rgba(139,148,158,.12)` |

Card: `rx="14"`, 1px border, 880 viewBox width.

Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
Because the fallback font differs per OS and cannot be controlled, **every pill label uses
`textLength` + `lengthAdjust="spacing"`** so a wider fallback cannot overflow its rounded
rect. Headline text does not use `textLength` (glyph distortion would be visible); it is
given generous trailing space instead.

## Verification

1. Rasterize all six SVGs through headless Chromium at both color schemes; inspect visually.
2. Re-render with the font stack forcibly swapped to a wide fallback (e.g. DejaVu Sans) and
   confirm no pill label escapes its rect.
3. Confirm `<picture>` markup contains no `style`/`class` attribute.
4. Confirm each `alt` string is a meaningful sentence, not a filename.

## Accepted trade-offs

- **Hand-written, no generator, no CI drift check.** Adding a target to `napi.targets` will
  not update the art. This is the same failure mode that produced `node14`. Accepted
  deliberately.
- **`→ v26` freezes the upper bound.** `engines` says `>=25`, so Node 27 is supported the day
  it ships (2027-04-22) and the card will not know. The `<details>` table carries the exact
  range.
- **The card encodes a point-in-time release status.** "Maintenance LTS 22 · Active LTS 24 ·
  Current 26" is true on 2026-07-10. It goes stale on 2026-10-28, when v26 becomes LTS.

When any of these bite, the fix is three files in `assets/` plus the table.

## Out of scope

- The CI label bug: the build job is named `node@22` (`CI.yml:123`) but installs node 24
  (`CI.yml:131`).
- The stale version guard in the generated root `index.js` (expects `1.4.4`, package is
  `1.4.5`).
- Adding CI coverage for the untested targets.
