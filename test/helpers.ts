import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ServerlessFunctionDefinition,
	ServerlessLike,
	ServerlessPackageConfig,
} from "../src/types";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export async function createTempService(
	files: Record<string, string>,
): Promise<string> {
	const serviceDir = await mkdtemp(path.join(tmpdir(), "serverless-rolldown-"));

	for (const [relativePath, contents] of Object.entries(files)) {
		const absolutePath = path.join(serviceDir, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, contents, "utf8");
	}

	return serviceDir;
}

export async function copyFixture(name: string): Promise<string> {
	const sourceDirectory = path.join(TEST_DIRECTORY, "fixtures", name);
	const rootDirectory = await mkdtemp(
		path.join(tmpdir(), "serverless-rolldown-"),
	);
	const targetDirectory = path.join(rootDirectory, name);
	await cp(sourceDirectory, targetDirectory, { recursive: true });
	return targetDirectory;
}

export async function removeDirectory(directory: string): Promise<void> {
	await rm(directory, { force: true, recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export interface CreateServerlessMockOptions {
	custom?: Record<string, unknown>;
	functions: Record<string, ServerlessFunctionDefinition>;
	providerRuntime?: string;
	serviceDir: string;
	servicePackage?: ServerlessPackageConfig;
}

export function createServerlessMock(
	options: CreateServerlessMockOptions,
): ServerlessLike {
	const functions = options.functions;
	const servicePackage = options.servicePackage ?? {};

	return {
		cli: {
			log() {},
		},
		config: {
			servicePath: options.serviceDir,
		},
		service: {
			custom: options.custom,
			functions,
			getAllFunctions() {
				return Object.keys(functions);
			},
			getFunction(name: string) {
				return functions[name] as ServerlessFunctionDefinition;
			},
			package: servicePackage,
			provider: {
				runtime: options.providerRuntime,
			},
		},
		serviceDir: options.serviceDir,
	};
}
