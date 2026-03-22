import path from "node:path";
import { discoverLocalLayers } from "./layers.js";
import {
  resolveHandlerEntryFile,
  sanitizeFileName,
  stripKnownEntryExtension,
  toPosixPath,
} from "./paths.js";
import type {
  BuildTarget,
  HandlerParts,
  LocalBuildPlan,
  PackagingPlan,
  ResolvedLocalLayer,
  ServerlessFunctionDefinition,
  ServerlessLike,
  ServerlessPackageConfig,
  ServerlessRolldownOptions,
} from "./types.js";

function getServicePackage(
  serverless: ServerlessLike,
): ServerlessPackageConfig {
  serverless.service.package ??= {};
  return serverless.service.package;
}

function getFunctionPackage(
  definition: ServerlessFunctionDefinition,
): ServerlessPackageConfig {
  definition.package ??= {};
  return definition.package;
}

function collectPositivePatterns(
  packageConfig?: ServerlessPackageConfig,
): string[] {
  const patterns = packageConfig?.patterns ?? [];
  const include = packageConfig?.include ?? [];
  return [...patterns, ...include].filter(
    (pattern) => !pattern.startsWith("!"),
  );
}

function setPackagePatterns(
  packageConfig: ServerlessPackageConfig,
  patterns: string[],
): void {
  packageConfig.exclude = [];
  packageConfig.include = [];
  packageConfig.patterns = Array.from(new Set(["!**", ...patterns]));
}

export function parseHandler(handler: string): HandlerParts {
  const separatorIndex = handler.lastIndexOf(".");

  if (separatorIndex <= 0 || separatorIndex === handler.length - 1) {
    throw new Error(
      `Invalid handler "${handler}". Expected the format "path/to/file.exportName".`,
    );
  }

  return {
    entry: handler.slice(0, separatorIndex),
    exportName: handler.slice(separatorIndex + 1),
  };
}

function isNodeRuntime(runtime?: string): boolean {
  return !runtime || runtime.startsWith("nodejs");
}

function hasConfiguredServiceArtifact(serverless: ServerlessLike): boolean {
  if (serverless.configurationInput) {
    return Boolean(serverless.configurationInput.package?.artifact);
  }

  return Boolean(serverless.service.package?.artifact);
}

function hasConfiguredFunctionArtifact(
  serverless: ServerlessLike,
  functionName: string,
  definition: ServerlessFunctionDefinition,
): boolean {
  if (serverless.configurationInput) {
    return Boolean(
      serverless.configurationInput.functions?.[functionName]?.package
        ?.artifact,
    );
  }

  return Boolean(definition.package?.artifact);
}

function shouldSkipFunction(
  definition: ServerlessFunctionDefinition,
  providerRuntime?: string,
): string | undefined {
  if (definition.image) {
    return "image-based function";
  }

  if (typeof definition.handler !== "string") {
    return "non-string handler";
  }

  if (!isNodeRuntime(definition.runtime ?? providerRuntime)) {
    return "non-Node runtime";
  }

  return undefined;
}

function createEntryKeys(functionNames: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  const entryKeys = new Map<string, string>();

  for (const functionName of functionNames) {
    const baseName = sanitizeFileName(functionName);
    const nextCount = (counts.get(baseName) ?? 0) + 1;
    counts.set(baseName, nextCount);

    const uniqueName = nextCount === 1 ? baseName : `${baseName}-${nextCount}`;
    entryKeys.set(functionName, `functions/${uniqueName}/index`);
  }

  return entryKeys;
}

async function createBuildTargets(
  functionNames: string[],
  serviceDir: string,
  serverless: ServerlessLike,
  requireIndividualArtifactCheck: boolean,
): Promise<BuildTarget[]> {
  const entryKeys = createEntryKeys(functionNames);
  const providerRuntime = serverless.service.provider?.runtime;
  const targets: BuildTarget[] = [];

  for (const functionName of functionNames) {
    const definition = serverless.service.getFunction(functionName);

    if (!definition) {
      throw new Error(
        `Unable to find the function "${functionName}" in the Serverless service.`,
      );
    }

    const skipReason = shouldSkipFunction(definition, providerRuntime);
    if (skipReason) {
      continue;
    }

    if (
      requireIndividualArtifactCheck &&
      hasConfiguredFunctionArtifact(serverless, functionName, definition)
    ) {
      continue;
    }

    const handler = parseHandler(definition.handler as string);
    const entryFile = await resolveHandlerEntryFile(serviceDir, handler.entry);
    const entryKey = entryKeys.get(functionName);

    if (!entryKey) {
      throw new Error(
        `Missing output entry key for function "${functionName}".`,
      );
    }

    targets.push({
      entryFile,
      entryKey,
      functionName,
      handlerExportName: handler.exportName,
      handlerPath: handler.entry,
      outputDirectory: path.posix.dirname(entryKey),
      outputFile: `${entryKey}.js`,
    });
  }

  return targets;
}

async function discoverPlanLayers(
  serverless: ServerlessLike,
  targets: BuildTarget[],
  serviceDir: string,
): Promise<ResolvedLocalLayer[]> {
  return discoverLocalLayers(
    serverless,
    targets.map((target) => target.functionName),
    serviceDir,
  );
}

export interface BuildPlanRequest {
  options: ServerlessRolldownOptions;
  serviceDir: string;
  serverless: ServerlessLike;
}

export interface LocalBuildPlanRequest {
  functionNames: string[];
  serviceDir: string;
  serverless: ServerlessLike;
}

export async function createPackagingPlan(
  request: BuildPlanRequest,
): Promise<PackagingPlan> {
  const { options, serviceDir, serverless } = request;
  const servicePackage = getServicePackage(serverless);
  const targetedFunctionNames = options.function
    ? [options.function]
    : serverless.service.getAllFunctions();

  if (options.function && targetedFunctionNames.length !== 1) {
    throw new Error(
      `Unable to find the function "${options.function}" in the Serverless service.`,
    );
  }

  if (
    !options.function &&
    !servicePackage.individually &&
    hasConfiguredServiceArtifact(serverless)
  ) {
    return {
      individualTargets: [],
      localLayers: [],
      servicePositivePatterns: collectPositivePatterns(servicePackage),
      serviceTargets: [],
    };
  }

  const singleFunctionMode = Boolean(
    options.function || servicePackage.individually,
  );
  const targets = await createBuildTargets(
    targetedFunctionNames,
    serviceDir,
    serverless,
    singleFunctionMode,
  );

  return {
    individualTargets: singleFunctionMode ? targets : [],
    localLayers: await discoverPlanLayers(serverless, targets, serviceDir),
    servicePositivePatterns: collectPositivePatterns(servicePackage),
    serviceTargets: singleFunctionMode ? [] : targets,
  };
}

export async function createLocalBuildPlan(
  request: LocalBuildPlanRequest,
): Promise<LocalBuildPlan> {
  const targets = await createBuildTargets(
    request.functionNames,
    request.serviceDir,
    request.serverless,
    false,
  );

  return {
    localLayers: await discoverPlanLayers(
      request.serverless,
      targets,
      request.serviceDir,
    ),
    targets,
  };
}

export function applyPackagingPlan(
  serverless: ServerlessLike,
  plan: PackagingPlan,
  relativeOutDir: string,
): void {
  if (plan.serviceTargets.length > 0) {
    const servicePackage = getServicePackage(serverless);
    setPackagePatterns(servicePackage, [
      `${toPosixPath(relativeOutDir)}/**`,
      ...plan.servicePositivePatterns,
    ]);

    for (const target of plan.serviceTargets) {
      const definition = serverless.service.getFunction(target.functionName);
      definition.handler = createRewrittenHandler(relativeOutDir, target);
    }
  }

  for (const target of plan.individualTargets) {
    const definition = serverless.service.getFunction(target.functionName);
    const functionPackage = getFunctionPackage(definition);
    const functionPositivePatterns = collectPositivePatterns(functionPackage);

    setPackagePatterns(functionPackage, [
      `${toPosixPath(path.posix.join(relativeOutDir, target.outputDirectory))}/**`,
      ...plan.servicePositivePatterns,
      ...functionPositivePatterns,
    ]);

    definition.handler = createRewrittenHandler(relativeOutDir, target);
  }
}

export function applyLocalBuildPlan(
  serverless: ServerlessLike,
  plan: LocalBuildPlan,
  relativeOutDir: string,
): void {
  for (const target of plan.targets) {
    serverless.service.getFunction(target.functionName).handler =
      createRewrittenHandler(relativeOutDir, target);
  }
}

export function createRewrittenHandler(
  relativeOutDir: string,
  target: BuildTarget,
): string {
  return `${stripKnownEntryExtension(toPosixPath(path.posix.join(relativeOutDir, target.entryKey)))}.${target.handlerExportName}`;
}
