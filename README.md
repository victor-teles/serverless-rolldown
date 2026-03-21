# serverless-rolldown

Serverless Framework v4 plugin that bundles Node.js Lambda handlers with Rolldown before packaging.

## What it does

- Hooks into `before:package:createDeploymentArtifacts`
- Hooks into `before:deploy:function:packageFunction`
- Auto-loads `rolldown.config.{js,mjs,cjs,ts,mts,cts}` from the service root
- Falls back to built-in Node Lambda defaults when no Rolldown config exists
- Bundles only the functions Serverless is packaging
- Rewrites handlers in memory to point at the generated bundles
- Narrows package patterns to the staged Rolldown output

## Install

```bash
bun install
bun run build
```

## Usage

```yaml
plugins:
  - serverless-rolldown
```

Optional plugin config:

```yaml
custom:
  rolldown:
    configFile: ./rolldown.config.ts
    outDir: ./.serverless/build
```

If `configFile` is omitted, the plugin searches the service root for `rolldown.config.*`.

## Rolldown config contract

v1 accepts a single Rolldown config object export. Config arrays and config functions are rejected for now.

The plugin owns:

- `input`
- output directory
- handler mapping
- Node/CJS Lambda output mode

Your Rolldown config can still customize normal bundler behavior such as plugins, resolve aliases, externals, and transforms.

## Scripts

```bash
bun test
bun run typecheck
bun run build
```
