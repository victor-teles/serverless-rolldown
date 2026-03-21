import { expect, test } from "bun:test";
import path from "node:path";
import {
	findRolldownConfigPath,
	loadPluginRolldownConfig,
} from "../src/config";
import { createTempService, removeDirectory } from "./helpers";

test("finds rolldown.config files automatically", async () => {
	const serviceDir = await createTempService({
		"rolldown.config.ts": "export default { treeshake: false };\n",
	});

	try {
		expect(await findRolldownConfigPath(serviceDir)).toBe(
			path.join(serviceDir, "rolldown.config.ts"),
		);
	} finally {
		await removeDirectory(serviceDir);
	}
});

test("falls back to built-in defaults when no config file exists", async () => {
	const serviceDir = await createTempService({
		"src/handler.ts": "export const handler = () => 'ok';\n",
	});

	try {
		await expect(loadPluginRolldownConfig(serviceDir)).resolves.toEqual({
			config: {},
		});
	} finally {
		await removeDirectory(serviceDir);
	}
});

test("rejects config arrays", async () => {
	const serviceDir = await createTempService({
		"rolldown.config.ts": "export default [{ treeshake: false }];\n",
	});

	try {
		await expect(loadPluginRolldownConfig(serviceDir)).rejects.toThrow(
			/config arrays are not supported yet/u,
		);
	} finally {
		await removeDirectory(serviceDir);
	}
});

test("rejects config functions", async () => {
	const serviceDir = await createTempService({
		"rolldown.config.ts": "export default () => ({ treeshake: false });\n",
	});

	try {
		await expect(loadPluginRolldownConfig(serviceDir)).rejects.toThrow(
			/config functions are not supported yet/u,
		);
	} finally {
		await removeDirectory(serviceDir);
	}
});
