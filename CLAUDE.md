# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

mcsrc.dev — a browser-based Minecraft source code viewer. It downloads the official Minecraft client jar directly from Mojang, remaps it from obfuscated to Mojang's official (deobfuscated) names, decompiles classes to Java on the fly, and presents an IDE-like UI (file tree, tabs, code view, diff view, inheritance graph, find references/definition) entirely client-side. Not affiliated with Mojang/Microsoft; no Minecraft code is redistributed — everything is fetched from Mojang's servers into the user's browser at runtime.

## Commands

Build the Java/TeaVM piece first — the frontend imports its generated output directly:

```bash
cd java && ./gradlew build
```

Then, from the repo root:

```bash
nvm use              # Node version pinned in .nvmrc
npm install
npm run dev           # Vite dev server
npm run dev:javadoc   # Dev server in "javadoc editor" mode (VITE_JAVADOC_EDITOR=true)
npm run build         # tsc -b && vite build
npm run test          # vitest run (unit tests, *.test.ts next to source)
npm run test:e2e      # playwright test (integration, tests/*.spec.ts)
npm run test:e2e:ui   # playwright UI mode
npm run lint          # oxlint --type-aware --deny-warnings
npm run lint:fix
```

Run a single unit test file: `npx vitest run src/logic/Search.test.ts`
Run a single e2e spec: `npx playwright test tests/diff.spec.ts` (add `--project=chromium|firefox|webkit`)

E2E tests build+preview the app automatically (`npm run build && npm run preview` per `playwright.config.ts`) unless `CI` is set, and they mock network calls to Mojang's version manifest with local fixture jars built from `java/src/dummy{1,2,3,4}` (see `java/build.gradle`'s `dummyNJar` tasks and `tests/test-utils.ts`). If you change anything under `java/`, rerun `./gradlew build` before e2e tests or they'll run against stale WASM/JS output.

CI (`.github/workflows/build.yml`) runs: `./gradlew build` (in `java/`) → `npm ci` → `npm run build` → `npm run test` → `npm run lint` → e2e matrix across Windows/chromium, Ubuntu/firefox, macOS/webkit.

## Architecture

### Two build systems feeding one app

The Java subproject (`java/`, Gradle) is compiled by **TeaVM** to both WebAssembly (GC) and JS fallback — see `java/build.gradle`'s `teavm` block, entry point `mcsrc.Indexer` (`java/src/main/java/mcsrc/Indexer.java`). Output lands in `java/build/generated/teavm/{wasm-gc,js}/` and is imported *directly* by frontend TS via relative paths (e.g. `src/workers/remap/worker.ts` imports `../../../java/build/generated/teavm/wasm-gc/java.wasm-runtime.js`). There is no npm package boundary here — the Java build must run before the frontend build/tests will type-check or work correctly. The Java side exposes `@JSExport` static methods (indexing, remapping, bytecode disassembly) consumed as a WASM module with automatic JS fallback if WASM fails to load (older/non-compliant browsers).

Decompilation to Java source (not just bytecode disassembly) is handled by a separate WASM/JS toolchain: **VineFlower**, wrapped via the `@run-slicer/vf` npm package (`src/logic/vf.ts`), same wasm-with-JS-fallback loading pattern.

### Everything heavy runs in Web Workers via Comlink

`src/workers/{decompile,jar-index,remap}/` — each has a `worker.ts` (the actual implementation, `Comlink.expose(...)`) and a `client.ts` (the main-thread proxy). Never do decompilation, remapping, or indexing on the main thread.

- **remap**: obfuscated jar + Mojang mappings → deobfuscated jar, using the TeaVM-compiled remapper. Results are cached in the Cache API keyed by `getRemappedJarCacheKey()` (`src/logic/MinecraftApi.ts`), versioned via `REMAPPED_JAR_CACHE_VERSION` — bump this if the remap output format changes.
- **jar-index**: builds cross-references (find usages, find declaration) using the same TeaVM indexer.
- **decompile**: runs VineFlower per-class, parallelized across multiple worker instances coordinated with a `SharedArrayBuffer` + `Atomics` work-stealing loop (see `decompileMany`/`remapClasses` in the worker files — this pattern repeats across all three workers for batch operations). Results (source + syntax token spans for hover/go-to-definition) are cached in IndexedDB via Dexie (`decompiler` DB, `results3` table, keyed by `[className+checksum+language]`).

Note `vite.config.ts` sets COOP/COEP headers (required for `SharedArrayBuffer`) and disables caching in dev (WebKit-specific issue).

### Data flow (high level)

1. `src/logic/MinecraftApi.ts` fetches the Mojang version manifest (plus `experimental_versions.json` for versions not in Mojang's manifest, e.g. very old or otherwise-unlisted builds), downloads the selected version's client jar + mappings, and remaps if mappings exist. Downloaded/remapped blobs are cached via the Cache API. `isUnobfuscated()` special-cases versions that ship already-deobfuscated (no remap needed).
2. `src/logic/State.ts` holds all user-facing global state as RxJS `BehaviorSubject`s (selected version, open tabs, selected file/lines, search query, diff view state, etc.) — this is the single source of truth; UI components subscribe to these rather than holding their own duplicate state.
3. `src/logic/Permalink.ts` serializes/deserializes relevant `State.ts` subjects to/from the URL, so views are shareable/bookmarkable; `getInitialState()` seeds `State.ts` on load.
4. `src/logic/tabs/` models open editor tabs (`CodeTab`, `InheritanceViewTab`); `src/logic/Decompiler.ts` and the decompile worker client turn a selected class into rendered source + tokens.
5. `src/ui/Code.tsx` (Monaco-based) renders source with tokens driving hover info (`CodeHoverProvider.ts`), go-to-definition, find-references, and context actions (`CodeContextActions.ts`, `CodeExtensions.ts`).
6. `src/ui/inheritance/` + `dagre`/`@xyflow/react` render the class inheritance graph as an interactive node graph.
7. `src/javadoc/` is a mode (gated by `VITE_JAVADOC_EDITOR`/`src/site.ts`'s `IS_JAVADOC_EDITOR`) for browsing/editing Javadoc comments against a separate API (`src/javadoc/api/JavadocApi.ts`), proxied to `localhost:8080/v1` in dev (see `vite.config.ts`).

### Testing conventions

- Unit tests: Vitest, `*.test.ts` colocated with the code under test (see `src/logic/*.test.ts`).
- Integration/e2e: Playwright, in `tests/*.spec.ts`. `tests/test-utils.ts` provides `setupTest()`/`setupNetworkMocking()` which intercepts the Mojang manifest and version downloads and serves the `dummy1-4` fixture jars/mappings built by the Gradle `dummyNJar` tasks instead, plus `setupTest()` auto-accepts the EULA modal and seeds `localStorage` settings. Use `waitForDecompiledContent()` / `selectMinecraftVersion()` helpers from that file rather than re-deriving the same waits/selectors in each spec.

### Deployment

Static SPA deployed to Cloudflare Workers (`wrangler.jsonc`, assets-only Worker serving `./dist/` with SPA fallback).

## Code style (from `.github/copilot-instructions.md`)

- Code should be self-documenting; only comment where intent isn't obvious from the code itself.
- Prefer minimal code — avoid speculative abstraction.
- Lean on TypeScript's type system; add specific types/interfaces rather than loosening types.
- Use RxJS for state management and async flows where it fits the existing patterns in `src/logic/State.ts` and friends.
