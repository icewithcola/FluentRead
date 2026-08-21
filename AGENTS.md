# Agent notes

This repository is **Bun-first**. Use Bun for install, add/remove, and script runs. Do not use npm, pnpm, or yarn, and do not create or commit `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`.

## Commands

```bash
bun install              # install from bun.lock
bun run dev              # WXT dev server with hot reload
bun run dev:firefox      # Firefox dev
bun run build            # production Chrome build
bun run build:debug      # unminified build with sourcemaps (`WXT_DEBUG=true`)
bun run build:firefox    # production Firefox build
bun run compile          # vue-tsc --noEmit
bun run zip              # pack Chrome zip
bun run zip:firefox      # pack Firefox zip
bun run docs:dev         # VitePress docs
```

Add a dependency with `bun add <pkg>` and a dev dependency with `bun add -d <pkg>`. After changing dependencies, commit the updated `bun.lock`.

CI installs with `bun install --frozen-lockfile`. If the lockfile is stale, refresh it with `bun install` locally rather than editing it by hand.

## Stack

Browser extension (WXT + Vue 3 + TypeScript + Element Plus). Content-script translation lives under `entrypoints/`; popup UI under `entrypoints/popup/` and `components/`. `wxt prepare` runs from the `postinstall` script and writes `.wxt/` (gitignored).

`package.json` `scripts` run through Bun's shell, so environment variables such as `WXT_DEBUG=true` work without `cross-env`.
