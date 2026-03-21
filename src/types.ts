export interface RolldownCustomConfig {
	configFile?: string;
	outDir?: string;
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
	package?: ServerlessPackageConfig;
	runtime?: string;
}

export interface ServerlessService {
	custom?: Record<string, unknown> & {
		rolldown?: RolldownCustomConfig;
	};
	functions?: Record<string, ServerlessFunctionDefinition>;
	getAllFunctions(): string[];
	getFunction(name: string): ServerlessFunctionDefinition;
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
	service: ServerlessService;
	serviceDir?: string;
}

export interface ServerlessRolldownOptions {
	function?: string;
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
	serviceTargets: BuildTarget[];
	servicePositivePatterns: string[];
}
