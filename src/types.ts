export interface RolldownCustomConfig {
  configFile?: string;
  noBuild?: boolean;
  noWatch?: boolean;
  outDir?: string;
  usePolling?: boolean | number;
}

export interface ServerlessPackageConfig {
  artifact?: string;
  exclude?: string[];
  include?: string[];
  individually?: boolean;
  patterns?: string[];
}

export interface ServerlessFunctionDefinition {
  handler?: string;
  image?: Record<string, unknown> | string;
  layers?: ServerlessLayerReference[];
  package?: ServerlessPackageConfig;
  runtime?: string;
}

export interface ServerlessLayerDefinition {
  path?: string;
  package?: ServerlessPackageConfig;
}

export type ServerlessLayerReference =
  | string
  | {
      Ref?: string;
    };

export interface ServerlessService {
  custom?: Record<string, unknown> & {
    rolldown?: RolldownCustomConfig;
  };
  functions?: Record<string, ServerlessFunctionDefinition>;
  getAllFunctions(): string[];
  getFunction(name: string): ServerlessFunctionDefinition;
  layers?: Record<string, ServerlessLayerDefinition>;
  package?: ServerlessPackageConfig;
  provider?: {
    runtime?: string;
  };
}

export interface ServerlessLike {
  cli?: {
    log(message: string): void;
  };
  config?: {
    servicePath?: string;
  };
  configurationInput?: {
    functions?: Record<string, ServerlessFunctionDefinition>;
    package?: ServerlessPackageConfig;
  };
  service: ServerlessService;
  serviceDir?: string;
}

export interface ServerlessRolldownOptions {
  function?: string;
  rolldownNoWatch?: boolean;
  rolldownUsePolling?: boolean | number | string;
  skipBuild?: boolean;
  watch?: boolean;
  [key: string]: unknown;
}

export interface HandlerParts {
  entry: string;
  exportName: string;
}

export interface BuildTarget {
  entryFile: string;
  entryKey: string;
  functionName: string;
  handlerExportName: string;
  handlerPath: string;
  outputDirectory: string;
  outputFile: string;
}

export interface PackagingPlan {
  individualTargets: BuildTarget[];
  localLayers: ResolvedLocalLayer[];
  serviceTargets: BuildTarget[];
  servicePositivePatterns: string[];
}

export interface LocalBuildPlan {
  localLayers: ResolvedLocalLayer[];
  targets: BuildTarget[];
}

export interface ResolvedLocalLayer {
  layerName: string;
  nodePaths: string[];
  sourcePath: string;
}

export interface StagedLocalLayer extends ResolvedLocalLayer {
  stageNodePaths: string[];
  stagePath: string;
}
