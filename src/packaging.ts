import path from "node:path";
import {
	resolveHandlerEntryFile,
	sanitizeFileName,
	stripKnownEntryExtension,
	toPosixPath,
} from "./paths.js";
import type {
	BuildTarget,
	HandlerParts,
	PackagingPlan,
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

function shouldSkipFunction(
	definition: ServerlessFunctionDefinition,
	providerRuntime?: string,
	requireIndividualArtifactCheck = false,
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

	if (requireIndividualArtifactCheck && definition.package?.artifact) {
		return "function artifact already set";
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

export interface BuildPlanRequest {
	options: ServerlessRolldownOptions;
	outDir: string;
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
		servicePackage.artifact
	) {
		return {
			individualTargets: [],
			servicePositivePatterns: collectPositivePatterns(servicePackage),
			serviceTargets: [],
		};
	}

	const entryKeys = createEntryKeys(targetedFunctionNames);
	const providerRuntime = serverless.service.provider?.runtime;
	const plan: PackagingPlan = {
		individualTargets: [],
		servicePositivePatterns: collectPositivePatterns(servicePackage),
		serviceTargets: [],
	};
	const singleFunctionMode = Boolean(
		options.function || servicePackage.individually,
	);

	for (const functionName of targetedFunctionNames) {
		const definition = serverless.service.getFunction(functionName);

		if (!definition) {
			throw new Error(
				`Unable to find the function "${functionName}" in the Serverless service.`,
			);
		}

		const skipReason = shouldSkipFunction(
			definition,
			providerRuntime,
			singleFunctionMode,
		);
		if (skipReason) {
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

		const target: BuildTarget = {
			entryFile,
			entryKey,
			functionName,
			handlerExportName: handler.exportName,
			handlerPath: handler.entry,
			outputDirectory: path.posix.dirname(entryKey),
			outputFile: `${entryKey}.js`,
		};

		if (singleFunctionMode) {
			plan.individualTargets.push(target);
		} else {
			plan.serviceTargets.push(target);
		}
	}

	return plan;
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

export function createRewrittenHandler(
	relativeOutDir: string,
	target: BuildTarget,
): string {
	return `${stripKnownEntryExtension(toPosixPath(path.posix.join(relativeOutDir, target.entryKey)))}.${target.handlerExportName}`;
}
