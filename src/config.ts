import { access } from "node:fs/promises";
import path from "node:path";
import {
  build,
  type ExternalOption,
  type InputOptions,
  type OutputOptions,
  type RolldownLog,
  type RolldownOptions,
  type RolldownWatcher,
  type WatcherOptions,
  watch,
} from "rolldown";
import { loadConfig } from "rolldown/config";
import {
  createLocalLayerImportMatcher,
  mergeExternalWithLocalLayers,
} from "./layers.js";
import { toPosixPath } from "./paths.js";
import type { ResolvedLocalLayer } from "./types.js";

const SUPPORTED_CONFIG_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
];
export const DEFAULT_OUT_DIR = ".serverless/build";

export interface LoadedRolldownConfig {
  configPath?: string;
  config: RolldownOptions;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findRolldownConfigPath(
  serviceDir: string,
  configFile?: string,
): Promise<string | undefined> {
  if (configFile) {
    const resolvedPath = path.resolve(serviceDir, configFile);
    if (!(await fileExists(resolvedPath))) {
      throw new Error(
        `Unable to find the configured Rolldown config at "${resolvedPath}".`,
      );
    }
    return resolvedPath;
  }

  for (const extension of SUPPORTED_CONFIG_EXTENSIONS) {
    const candidate = path.join(serviceDir, `rolldown.config${extension}`);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export async function loadPluginRolldownConfig(
  serviceDir: string,
  configFile?: string,
): Promise<LoadedRolldownConfig> {
  const configPath = await findRolldownConfigPath(serviceDir, configFile);

  if (!configPath) {
    return {
      config: {},
    };
  }

  const loadedConfig = await loadConfig(configPath);

  if (typeof loadedConfig === "function") {
    throw new Error(
      `Rolldown config functions are not supported yet. Export a single config object from "${configPath}".`,
    );
  }

  if (Array.isArray(loadedConfig)) {
    throw new Error(
      `Rolldown config arrays are not supported yet. Export a single config object from "${configPath}".`,
    );
  }

  return {
    config: loadedConfig,
    configPath,
  };
}

export function resolveOutputDirectory(
  serviceDir: string,
  outDir?: string,
): string {
  if (!outDir && path.basename(serviceDir) === "build") {
    const parentDirectory = path.basename(path.dirname(serviceDir));
    if (parentDirectory === ".serverless") {
      return serviceDir;
    }
  }

  const resolvedOutDir = path.resolve(serviceDir, outDir ?? DEFAULT_OUT_DIR);
  const relativeOutDir = path.relative(serviceDir, resolvedOutDir);

  if (
    relativeOutDir === "" ||
    relativeOutDir === "." ||
    relativeOutDir.startsWith("..") ||
    path.isAbsolute(relativeOutDir)
  ) {
    throw new Error(
      `The Rolldown output directory must stay inside the service directory. Received "${resolvedOutDir}".`,
    );
  }

  return resolvedOutDir;
}

export interface BuildRequest {
  config: RolldownOptions;
  localLayers?: ResolvedLocalLayer[];
  outDir: string;
  serviceDir: string;
  singleEntry: boolean;
  targets: Array<{
    entryFile: string;
    entryKey: string;
  }>;
  usePolling?: number;
}

function normalizeUserOutput(
  output?: OutputOptions | OutputOptions[],
): OutputOptions {
  if (!output) {
    return {};
  }

  if (Array.isArray(output)) {
    throw new Error(
      "Rolldown output arrays are not supported yet. Export a single output object.",
    );
  }

  return output;
}

function createInput(entries: BuildRequest["targets"]): InputOptions["input"] {
  if (entries.length === 1) {
    return entries[0]?.entryFile;
  }

  return Object.fromEntries(
    entries.map((target) => [target.entryKey, target.entryFile]),
  );
}

function createOutputOptions(
  userOutput: OutputOptions,
  request: BuildRequest,
): OutputOptions {
  const baseOutput: OutputOptions = {
    ...userOutput,
    chunkFileNames: userOutput.chunkFileNames ?? "_chunks/[name]-[hash].js",
    dir: request.outDir,
    entryFileNames:
      request.targets.length === 1
        ? `${request.targets[0]?.entryKey}.js`
        : (userOutput.entryFileNames ?? "[name].js"),
    format: "cjs",
    preserveModules: false,
  };

  if (request.singleEntry) {
    return {
      ...baseOutput,
      codeSplitting: false,
    };
  }

  if (userOutput.codeSplitting === false) {
    return {
      ...baseOutput,
      codeSplitting: true,
    };
  }

  return baseOutput;
}

function createExternalOption(
  request: BuildRequest,
): ExternalOption | undefined {
  return mergeExternalWithLocalLayers(
    request.serviceDir,
    request.localLayers ?? [],
    request.config.external,
  );
}

function extractUnresolvedImportSpecifier(
  log: Pick<RolldownLog, "code" | "exporter" | "message">,
): string | undefined {
  if (log.code !== "UNRESOLVED_IMPORT") {
    return undefined;
  }

  if (log.exporter) {
    return log.exporter;
  }

  const matchedSpecifier = /Could not resolve ['"]([^'"]+)['"]/u.exec(
    log.message,
  )?.[1];

  return matchedSpecifier;
}

function createOnLogHandler(
  request: BuildRequest,
): RolldownOptions["onLog"] | undefined {
  const userOnLog = request.config.onLog;
  const localLayers = request.localLayers ?? [];

  if (localLayers.length === 0) {
    return userOnLog;
  }

  const matchesLayerImport = createLocalLayerImportMatcher(
    request.serviceDir,
    localLayers,
  );

  return (level, log, defaultHandler) => {
    if (level === "warn") {
      const unresolvedSpecifier = extractUnresolvedImportSpecifier(log);
      if (unresolvedSpecifier && matchesLayerImport(unresolvedSpecifier)) {
        return;
      }
    }

    if (userOnLog) {
      userOnLog(level, log, defaultHandler);
      return;
    }

    defaultHandler(level, log);
  };
}

function createWatchOptions(
  watchOptions: RolldownOptions["watch"],
  usePolling?: number,
): WatcherOptions | false | undefined {
  if (watchOptions === false) {
    return {
      watcher: usePolling ? { pollInterval: usePolling } : undefined,
    };
  }

  const baseWatchOptions = watchOptions ?? {};
  if (!usePolling) {
    return baseWatchOptions;
  }

  return {
    ...baseWatchOptions,
    watcher: {
      ...(baseWatchOptions.notify ?? baseWatchOptions.watcher ?? {}),
      pollInterval: usePolling,
    },
  };
}

function createInputOptions(request: BuildRequest): InputOptions {
  const input = createInput(request.targets);
  const cwd = request.config.cwd
    ? path.resolve(request.serviceDir, request.config.cwd)
    : request.serviceDir;

  return {
    ...request.config,
    cwd,
    external: createExternalOption(request),
    input,
    onLog: createOnLogHandler(request),
    platform: "node",
    watch: createWatchOptions(request.config.watch, request.usePolling),
  };
}

export async function runRolldownBuild(request: BuildRequest): Promise<void> {
  const userOutput = normalizeUserOutput(request.config.output);
  const output = createOutputOptions(userOutput, request);

  await build({
    ...createInputOptions(request),
    output,
    write: true,
  });
}

export function startRolldownWatch(request: BuildRequest): RolldownWatcher {
  const userOutput = normalizeUserOutput(request.config.output);
  const output = createOutputOptions(userOutput, request);

  return watch({
    ...createInputOptions(request),
    output,
  });
}

export function createBundledHandlerPath(
  outDir: string,
  entryKey: string,
  exportName: string,
): string {
  const relativeModulePath = stripTrailingJsExtension(
    toPosixPath(path.join(outDir, entryKey)),
  );
  return `${relativeModulePath}.${exportName}`;
}

function stripTrailingJsExtension(filePath: string): string {
  return filePath.replace(/\.js$/u, "");
}
