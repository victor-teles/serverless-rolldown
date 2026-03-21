import { rm } from "node:fs/promises";
import path from "node:path";
import {
	loadPluginRolldownConfig,
	resolveOutputDirectory,
	runRolldownBuild,
} from "./config.js";
import { applyPackagingPlan, createPackagingPlan } from "./packaging.js";
import type { ServerlessLike, ServerlessRolldownOptions } from "./types.js";

function resolveServiceDirectory(serverless: ServerlessLike): string {
	return (
		serverless.serviceDir ?? serverless.config?.servicePath ?? process.cwd()
	);
}

export default class ServerlessRolldown {
	static tags = ["build"];

	readonly hooks: Record<string, () => Promise<void>>;
	private readonly options: ServerlessRolldownOptions;
	private readonly serverless: ServerlessLike;

	constructor(
		serverless: ServerlessLike,
		options: ServerlessRolldownOptions = {},
	) {
		this.serverless = serverless;
		this.options = options;
		this.hooks = {
			"before:deploy:function:packageFunction":
				this.bundleForPackaging.bind(this),
			"before:package:createDeploymentArtifacts":
				this.bundleForPackaging.bind(this),
		};
	}

	private log(message: string): void {
		this.serverless.cli?.log(`[serverless-rolldown] ${message}`);
	}

	private async bundleForPackaging(): Promise<void> {
		const serviceDir = resolveServiceDirectory(this.serverless);
		const customConfig = this.serverless.service.custom?.rolldown;
		const absoluteOutDir = resolveOutputDirectory(
			serviceDir,
			customConfig?.outDir,
		);
		const relativeOutDir =
			path.relative(serviceDir, absoluteOutDir) ||
			path.basename(absoluteOutDir);
		const loadedConfig = await loadPluginRolldownConfig(
			serviceDir,
			customConfig?.configFile,
		);
		const packagingPlan = await createPackagingPlan({
			options: this.options,
			outDir: absoluteOutDir,
			serviceDir,
			serverless: this.serverless,
		});

		if (
			packagingPlan.serviceTargets.length === 0 &&
			packagingPlan.individualTargets.length === 0
		) {
			this.log("No eligible functions found for Rolldown bundling.");
			return;
		}

		this.log(
			loadedConfig.configPath
				? `Loaded Rolldown config from ${loadedConfig.configPath}.`
				: "Using built-in Rolldown defaults.",
		);

		await rm(absoluteOutDir, { force: true, recursive: true });

		if (packagingPlan.serviceTargets.length > 0) {
			await runRolldownBuild({
				config: loadedConfig.config,
				outDir: absoluteOutDir,
				serviceDir,
				singleEntry: false,
				targets: packagingPlan.serviceTargets.map((target) => ({
					entryFile: target.entryFile,
					entryKey: target.entryKey,
				})),
			});
		}

		for (const target of packagingPlan.individualTargets) {
			await runRolldownBuild({
				config: loadedConfig.config,
				outDir: absoluteOutDir,
				serviceDir,
				singleEntry: true,
				targets: [
					{
						entryFile: target.entryFile,
						entryKey: target.entryKey,
					},
				],
			});
		}

		applyPackagingPlan(this.serverless, packagingPlan, relativeOutDir);
		this.log("Bundled eligible functions with Rolldown.");
	}
}

export {
	DEFAULT_OUT_DIR,
	findRolldownConfigPath,
	loadPluginRolldownConfig,
	resolveOutputDirectory,
	runRolldownBuild,
} from "./config.js";
export { applyPackagingPlan, createPackagingPlan } from "./packaging.js";
