# serverless-rolldown

Serverless Framework v4 plugin that bundles Node.js Lambda handlers with Rolldown for packaging and local execution.

## What You Get

- Rolldown-powered builds for `serverless package`, `serverless deploy`, and `serverless deploy function`
- Local builds for `serverless invoke local`, `serverless invoke local --watch`, and `serverless-offline`
- Automatic loading of `rolldown.config.{js,mjs,cjs,ts,mts,cts}` from the service root
- Built-in Node/CommonJS defaults when no Rolldown config exists
- Handler rewriting in memory so Serverless points at the staged bundle output
- Separate output roots for package, invoke-local, and offline flows
- Local Node layer staging for local execution

## Current Scope

- Serverless Framework v4
- Node.js Lambda handlers
- Single Rolldown config object exports

The plugin does not support Rolldown config arrays or config functions yet.

## Quick Start

Install the plugin and its required peers in your Serverless service:

```bash
bun add -d serverless serverless-rolldown rolldown typescript
```

If you also want local HTTP development with `serverless-offline`:

```bash
bun add -d serverless-offline
```

Before using `serverless-rolldown`, disable Serverless Framework's built-in esbuild support:

```yaml
build:
  esbuild: false
```

Then add the plugin to `serverless.yml`:

```yaml
service: my-service
frameworkVersion: ^4

build:
  esbuild: false

provider:
  name: aws
  runtime: nodejs20.x

plugins:
  - serverless-rolldown
  - serverless-offline

functions:
  hello:
    handler: src/hello.handler
```

If you leave `esbuild` enabled, Serverless and this plugin will both try to control the build step.

`serverless-offline` should come after `serverless-rolldown` in the plugin list.

Then use normal Serverless commands:

```bash
serverless package
serverless invoke local --function hello
serverless offline
```

## Optional Config

```yaml
custom:
  rolldown:
    configFile: ./rolldown.config.ts
    outDir: ./.serverless/build
    noBuild: false
    noWatch: false
    usePolling: false
```

Supported plugin options:

- `configFile?: string`
- `outDir?: string`
- `noBuild?: boolean`
- `noWatch?: boolean`
- `usePolling?: boolean | number`

Defaults and CLI compatibility:

- Default `outDir` is `./.serverless/build`
- `--skip-build`
- `--rolldown-no-watch`
- `--rolldown-use-polling[=ms]`

## How Output Is Staged

- Package builds go under `<outDir>/package`
- `invoke local` builds go under `<outDir>/invoke-local`
- `serverless-offline` builds go under `<outDir>/offline`
- Watched `serverless-offline` runs enable `reloadHandler` automatically so edited handlers are reloaded between requests

## Rolldown Config Contract

The plugin owns a few parts of the final build shape:

- `input`
- Stage-specific output directories
- Handler mapping
- Node/CommonJS Lambda output mode

Your Rolldown config can still customize normal bundler behavior such as plugins, aliases, externals, and transforms.

## Local Development

This repo uses Bun for development.

Install dependencies:

```bash
bun install
```

Common commands:

```bash
bun test
bun run typecheck
bun run build
bun run validate:example
```

`bun run validate:example` builds the plugin, installs the example app if needed, and runs the example smoke validation.

## Example App

The [`example`](./example) directory is a small Serverless v4 app wired to the local plugin build.

Useful commands inside `example/`:

```bash
bun install
bun run package
bun run invoke:hello
bun run dev
bun run validate
```

Use `bun run dev` for local HTTP development with `serverless-offline`.

## Notes

- Local layer support is Node-only, path-based, and copy-as-is
- Layer imports are treated as runtime externals when they resolve from referenced local layers
- Layer artifact packaging still relies on native Serverless behavior

## Publishing

- Add an `NPM_TOKEN` repository secret before using the publish workflow
- Push a tag in the format `vX.Y.Z` from the current `main` HEAD to trigger publish
- The publish workflow updates `package.json` from the tag version, then runs `bun test`, `bun run typecheck`, and `bun run build` before `npm publish`
- If the tag version changed `package.json`, the workflow commits that version back to `main`
