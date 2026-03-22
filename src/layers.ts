import { realpathSync } from "node:fs";
import { access, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { ExternalOption, ExternalOptionFunction } from "rolldown";
import { sanitizeFileName } from "./paths.js";
import type {
  ResolvedLocalLayer,
  ServerlessLayerReference,
  ServerlessLike,
  StagedLocalLayer,
} from "./types.js";

const NODE_LAYER_PATH_SEGMENTS = [["nodejs", "node_modules"], ["nodejs"]];

function isBareImport(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !path.isAbsolute(specifier) &&
    !specifier.startsWith("\0")
  );
}

function isArnReference(reference: string): boolean {
  return reference.startsWith("arn:");
}

function matchesExternalString(pattern: string, id: string): boolean {
  return id === pattern || id.startsWith(`${pattern}/`);
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

async function collectExistingLayerNodePaths(
  layerPath: string,
): Promise<string[]> {
  const nodePaths: string[] = [];

  for (const segments of NODE_LAYER_PATH_SEGMENTS) {
    const candidate = path.join(layerPath, ...segments);
    try {
      await access(candidate);
      nodePaths.push(candidate);
    } catch {
      // Ignore missing conventional layer paths.
    }
  }

  return nodePaths;
}

function matchesLayerReference(
  layerName: string,
  reference: ServerlessLayerReference,
): boolean {
  if (typeof reference === "string") {
    return !isArnReference(reference) && reference === layerName;
  }

  if (!reference?.Ref) {
    return false;
  }

  const logicalIdBase = toPascalCase(layerName);
  return [
    layerName,
    `${logicalIdBase}LambdaLayer`,
    `${logicalIdBase}LambdaLayerQualifiedArn`,
  ].includes(reference.Ref);
}

function createExistingExternalMatcher(
  external?: ExternalOption,
): ExternalOptionFunction | undefined {
  if (!external) {
    return undefined;
  }

  if (typeof external === "function") {
    return external;
  }

  if (Array.isArray(external)) {
    return (id) =>
      external.some((pattern) =>
        typeof pattern === "string"
          ? matchesExternalString(pattern, id)
          : pattern.test(id),
      );
  }

  if (typeof external === "string") {
    return (id) => matchesExternalString(external, id);
  }

  return (id) => external.test(id);
}

export async function discoverLocalLayers(
  serverless: ServerlessLike,
  functionNames: string[],
  serviceDir: string,
): Promise<ResolvedLocalLayer[]> {
  const serviceLayers = serverless.service.layers ?? {};
  const discoveredLayers = new Map<string, ResolvedLocalLayer>();

  for (const functionName of functionNames) {
    const functionDefinition = serverless.service.getFunction(functionName);

    for (const layerReference of functionDefinition.layers ?? []) {
      for (const [layerName, layerDefinition] of Object.entries(
        serviceLayers,
      )) {
        if (
          !matchesLayerReference(layerName, layerReference) ||
          !layerDefinition.path
        ) {
          continue;
        }

        if (discoveredLayers.has(layerName)) {
          continue;
        }

        const sourcePath = path.resolve(serviceDir, layerDefinition.path);
        discoveredLayers.set(layerName, {
          layerName,
          nodePaths: await collectExistingLayerNodePaths(sourcePath),
          sourcePath,
        });
      }
    }
  }

  return Array.from(discoveredLayers.values());
}

export function mergeExternalWithLocalLayers(
  serviceDir: string,
  layers: ResolvedLocalLayer[],
  external?: ExternalOption,
): ExternalOption | undefined {
  const matchesExistingExternal = createExistingExternalMatcher(external);
  const matchesLayerImport = createLocalLayerImportMatcher(serviceDir, layers);

  return (id, parentId, isResolved) => {
    if (matchesExistingExternal?.(id, parentId, isResolved)) {
      return true;
    }

    return matchesLayerImport(id);
  };
}

export function createLocalLayerImportMatcher(
  serviceDir: string,
  layers: ResolvedLocalLayer[],
): (id: string) => boolean {
  const layerResolvePaths = Array.from(
    new Set(layers.flatMap((layer) => layer.nodePaths)),
  );
  const normalizedLayerResolvePaths = layerResolvePaths.map((layerPath) => {
    try {
      return realpathSync.native(layerPath);
    } catch {
      return layerPath;
    }
  });

  if (layerResolvePaths.length === 0) {
    return () => false;
  }

  const localRequire = createRequire(
    path.join(serviceDir, "__serverless-rolldown__.cjs"),
  );

  return (id: string) => {
    if (!isBareImport(id)) {
      return false;
    }

    try {
      const resolvedPath = localRequire.resolve(id, {
        paths: layerResolvePaths,
      });
      const normalizedResolvedPath = (() => {
        try {
          return realpathSync.native(resolvedPath);
        } catch {
          return resolvedPath;
        }
      })();

      return normalizedLayerResolvePaths.some(
        (layerPath) =>
          normalizedResolvedPath === layerPath ||
          normalizedResolvedPath.startsWith(`${layerPath}${path.sep}`),
      );
    } catch {
      return false;
    }
  };
}

export async function stageLocalLayers(
  layers: ResolvedLocalLayer[],
  stageOutDir: string,
): Promise<StagedLocalLayer[]> {
  const stagedLayers: StagedLocalLayer[] = [];

  for (const layer of layers) {
    const stagePath = path.join(
      stageOutDir,
      "layers",
      sanitizeFileName(layer.layerName),
    );

    await cp(layer.sourcePath, stagePath, {
      force: true,
      recursive: true,
    });

    stagedLayers.push({
      ...layer,
      stageNodePaths: await collectExistingLayerNodePaths(stagePath),
      stagePath,
    });
  }

  return stagedLayers;
}
