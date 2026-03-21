import { access } from "node:fs/promises";
import path from "node:path";

const HANDLER_ENTRY_EXTENSIONS = [
	"",
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function toPosixPath(filePath: string): string {
	return filePath.split(path.sep).join(path.posix.sep);
}

export function sanitizeFileName(value: string): string {
	const sanitized = value
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "function";
}

export function stripKnownEntryExtension(filePath: string): string {
	return filePath.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

export async function resolveHandlerEntryFile(
	serviceDir: string,
	handlerPath: string,
): Promise<string> {
	const absoluteBasePath = path.resolve(serviceDir, handlerPath);

	for (const extension of HANDLER_ENTRY_EXTENSIONS) {
		const candidate = `${absoluteBasePath}${extension}`;
		if (await pathExists(candidate)) {
			return candidate;
		}
	}

	for (const extension of HANDLER_ENTRY_EXTENSIONS.slice(1)) {
		const candidate = path.join(absoluteBasePath, `index${extension}`);
		if (await pathExists(candidate)) {
			return candidate;
		}
	}

	throw new Error(
		`Unable to resolve the handler entry "${handlerPath}" from "${serviceDir}".`,
	);
}
