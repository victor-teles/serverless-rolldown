import { access, readFile, writeFile } from "node:fs/promises";
import * as NodeModule from "node:module";
import path from "node:path";
import { createRewrittenHandler } from "./packaging.js";
import type {
  BuildTarget,
  RolldownCustomConfig,
  ServerlessLike,
  ServerlessRolldownOptions,
  StagedLocalLayer,
} from "./types.js";

export type LocalMode = "invoke-local" | "offline";

export interface LocalExecutionSettings {
  skipBuild: boolean;
  usePolling?: number;
  watch: boolean;
}

export interface RuntimeSnapshot {
  handlers: Record<string, string | undefined>;
  nodePath?: string;
}

export interface LocalBuildManifest {
  functionNames: string[];
  handlers: Record<string, string>;
  layerNodePaths: string[];
  mode: LocalMode;
}

function getOptionValue(
  options: ServerlessRolldownOptions,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (key in options) {
      return options[key];
    }
  }

  return undefined;
}

function normalizePollingValue(value: unknown): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }

  if (value === true) {
    return 3000;
  }

  const numericValue =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);

  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : undefined;
}

function refreshNodePath(): void {
  const moduleApi = NodeModule.Module as typeof NodeModule.Module & {
    _initPaths?: () => void;
  };
  moduleApi._initPaths?.();
}

export function resolveLocalExecutionSettings(
  customConfig: RolldownCustomConfig | undefined,
  options: ServerlessRolldownOptions,
  mode: LocalMode,
): LocalExecutionSettings {
  const skipBuild =
    Boolean(customConfig?.noBuild) ||
    Boolean(getOptionValue(options, "skipBuild", "skip-build"));
  const noWatch =
    Boolean(customConfig?.noWatch) ||
    Boolean(getOptionValue(options, "rolldownNoWatch", "rolldown-no-watch"));
  const watch =
    !skipBuild &&
    !noWatch &&
    (mode === "offline" || Boolean(getOptionValue(options, "watch")));
  const usePolling = watch
    ? normalizePollingValue(
        getOptionValue(options, "rolldownUsePolling", "rolldown-use-polling") ??
          customConfig?.usePolling,
      )
    : undefined;

  return {
    skipBuild,
    usePolling,
    watch,
  };
}

export function captureRuntimeSnapshot(
  serverless: ServerlessLike,
  functionNames: string[],
): RuntimeSnapshot {
  return {
    handlers: Object.fromEntries(
      functionNames.map((functionName) => [
        functionName,
        serverless.service.getFunction(functionName).handler,
      ]),
    ),
    nodePath: process.env.NODE_PATH,
  };
}

export function restoreRuntimeSnapshot(
  serverless: ServerlessLike,
  snapshot: RuntimeSnapshot,
): void {
  for (const [functionName, handler] of Object.entries(snapshot.handlers)) {
    serverless.service.getFunction(functionName).handler = handler;
  }

  if (snapshot.nodePath === undefined) {
    delete process.env.NODE_PATH;
  } else {
    process.env.NODE_PATH = snapshot.nodePath;
  }

  refreshNodePath();
}

export function applyLocalManifest(
  serverless: ServerlessLike,
  manifest: LocalBuildManifest,
  serviceDir: string,
): void {
  for (const [functionName, handler] of Object.entries(manifest.handlers)) {
    serverless.service.getFunction(functionName).handler = handler;
  }

  const absoluteNodePaths = manifest.layerNodePaths.map((layerNodePath) =>
    path.resolve(serviceDir, layerNodePath),
  );
  const existingNodePaths = process.env.NODE_PATH
    ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean)
    : [];
  process.env.NODE_PATH = Array.from(
    new Set([...absoluteNodePaths, ...existingNodePaths]),
  ).join(path.delimiter);
  refreshNodePath();
}

export function createLocalBuildManifest(
  mode: LocalMode,
  serviceDir: string,
  targets: BuildTarget[],
  relativeStageOutDir: string,
  stagedLayers: StagedLocalLayer[],
): LocalBuildManifest {
  return {
    functionNames: targets.map((target) => target.functionName),
    handlers: Object.fromEntries(
      targets.map((target) => [
        target.functionName,
        createRewrittenHandler(relativeStageOutDir, target),
      ]),
    ),
    layerNodePaths: stagedLayers.flatMap((layer) =>
      layer.stageNodePaths.map((nodePath) =>
        path.relative(serviceDir, nodePath),
      ),
    ),
    mode,
  };
}

export function getLocalManifestPath(stageOutDir: string): string {
  return path.join(stageOutDir, "manifest.json");
}

export async function readLocalBuildManifest(
  manifestPath: string,
): Promise<LocalBuildManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as LocalBuildManifest;
  } catch {
    return undefined;
  }
}

export async function writeLocalBuildManifest(
  manifestPath: string,
  manifest: LocalBuildManifest,
): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

export async function validateLocalBuildManifest(
  serviceDir: string,
  stageOutDir: string,
  mode: LocalMode,
  functionNames: string[],
): Promise<LocalBuildManifest | undefined> {
  const manifestPath = getLocalManifestPath(stageOutDir);
  const manifest = await readLocalBuildManifest(manifestPath);

  if (
    !manifest ||
    manifest.mode !== mode ||
    manifest.functionNames.length !== functionNames.length ||
    !functionNames.every((functionName) =>
      manifest.functionNames.includes(functionName),
    )
  ) {
    return undefined;
  }

  for (const handler of Object.values(manifest.handlers)) {
    const outputFile = path.resolve(
      serviceDir,
      `${handler.slice(0, handler.lastIndexOf("."))}.js`,
    );

    try {
      await access(outputFile);
    } catch {
      return undefined;
    }
  }

  return manifest;
}
