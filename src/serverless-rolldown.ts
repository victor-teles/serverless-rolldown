import { rm } from "node:fs/promises";
import {
  loadPluginRolldownConfig,
  resolveOutputDirectory,
  runRolldownBuilds,
} from "./config.js";
import { stageLocalLayers } from "./layers.js";
import {
  applyLocalManifest,
  captureRuntimeSnapshot,
  createLocalBuildManifest,
  getLocalManifestPath,
  type LocalBuildManifest,
  type LocalMode,
  type RuntimeSnapshot,
  resolveLocalExecutionSettings,
  restoreRuntimeSnapshot,
  validateLocalBuildManifest,
  writeLocalBuildManifest,
} from "./local-runtime.js";
import {
  applyPackagingPlan,
  createLocalBuildPlan,
  createPackagingPlan,
  type LocalBuildPlanRequest,
} from "./packaging.js";
import {
  resolveStageOutDir,
  resolveStageRelativeOutDir,
  writeStagePackageJson,
} from "./stages.js";
import type { ServerlessLike, ServerlessRolldownOptions } from "./types.js";
import { LocalWatchController } from "./watch-controller.js";

interface ActiveLocalSession {
  controller?: LocalWatchController;
  mode: LocalMode;
  snapshot: RuntimeSnapshot;
  watchEnabled: boolean;
}

function resolveServiceDirectory(serverless: ServerlessLike): string {
  return (
    serverless.serviceDir ?? serverless.config?.servicePath ?? process.cwd()
  );
}

export default class ServerlessRolldown {
  static tags = ["build"];

  readonly hooks: Record<string, () => Promise<void>>;
  private activeLocalSession?: ActiveLocalSession;
  private readonly options: ServerlessRolldownOptions;
  private readonly serverless: ServerlessLike;

  constructor(
    serverless: ServerlessLike,
    options: ServerlessRolldownOptions = {},
  ) {
    this.serverless = serverless;
    this.options = options;
    this.hooks = {
      "after:invoke:local:invoke": this.finishInvokeLocal.bind(this),
      "before:deploy:function:packageFunction":
        this.bundleForPackaging.bind(this),
      "before:invoke:local:invoke": this.prepareInvokeLocal.bind(this),
      "before:offline:start": this.startOffline.bind(this),
      "before:offline:start:init": this.startOffline.bind(this),
      "before:package:createDeploymentArtifacts":
        this.bundleForPackaging.bind(this),
      "offline:start:end": this.stopOffline.bind(this),
    };

    process.once("exit", () => {
      void this.cleanup();
    });
  }

  private log(message: string): void {
    this.serverless.cli?.log(`[serverless-rolldown] ${message}`);
  }

  private ensureOfflineHandlerReload(): void {
    // biome-ignore lint/suspicious/noAssignInExpressions: please stop biome
    const customConfig = (this.serverless.service.custom ??= {});
    const offlineConfig = customConfig["serverless-offline"];

    if (offlineConfig === undefined) {
      customConfig["serverless-offline"] = {
        reloadHandler: true,
      };
      this.log(
        "Enabled serverless-offline handler reloading so watched offline bundles stay fresh.",
      );
      return;
    }

    if (
      typeof offlineConfig !== "object" ||
      offlineConfig === null ||
      Array.isArray(offlineConfig)
    ) {
      return;
    }

    const typedOfflineConfig = offlineConfig as Record<string, unknown>;
    if (typedOfflineConfig.reloadHandler !== undefined) {
      return;
    }

    typedOfflineConfig.reloadHandler = true;
    this.log(
      "Enabled serverless-offline handler reloading so watched offline bundles stay fresh.",
    );
  }

  private async runBuildTargets(
    config: Awaited<ReturnType<typeof loadPluginRolldownConfig>>["config"],
    localLayers: Awaited<ReturnType<typeof createPackagingPlan>>["localLayers"],
    serviceDir: string,
    stageOutDir: string,
    targets: Array<{
      entryFile: string;
      entryKey: string;
    }>,
  ): Promise<void> {
    await runRolldownBuilds({
      config,
      localLayers,
      outDir: stageOutDir,
      serviceDir,
      targets,
    });
  }

  private async bundleForPackaging(): Promise<void> {
    const serviceDir = resolveServiceDirectory(this.serverless);
    const customConfig = this.serverless.service.custom?.rolldown;
    const baseOutDir = resolveOutputDirectory(serviceDir, customConfig?.outDir);
    const packageOutDir = resolveStageOutDir(baseOutDir, "package");
    const relativeOutDir = resolveStageRelativeOutDir(
      serviceDir,
      packageOutDir,
    );
    const loadedConfig = await loadPluginRolldownConfig(
      serviceDir,
      customConfig?.configFile,
    );
    const packagingPlan = await createPackagingPlan({
      options: this.options,
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

    await rm(packageOutDir, { force: true, recursive: true });
    await writeStagePackageJson(packageOutDir);

    await this.runBuildTargets(
      loadedConfig.config,
      packagingPlan.localLayers,
      serviceDir,
      packageOutDir,
      packagingPlan.serviceTargets.map((target) => ({
        entryFile: target.entryFile,
        entryKey: target.entryKey,
      })),
    );

    for (const target of packagingPlan.individualTargets) {
      await this.runBuildTargets(
        loadedConfig.config,
        packagingPlan.localLayers,
        serviceDir,
        packageOutDir,
        [
          {
            entryFile: target.entryFile,
            entryKey: target.entryKey,
          },
        ],
      );
    }

    applyPackagingPlan(this.serverless, packagingPlan, relativeOutDir);
    this.log("Bundled eligible functions with Rolldown.");
  }

  private async prepareInvokeLocal(): Promise<void> {
    await this.prepareLocalRuntime("invoke-local");
  }

  private async finishInvokeLocal(): Promise<void> {
    if (
      this.activeLocalSession?.mode === "invoke-local" &&
      !this.activeLocalSession.watchEnabled
    ) {
      await this.cleanup();
    }
  }

  private async startOffline(): Promise<void> {
    await this.prepareLocalRuntime("offline");
  }

  private async stopOffline(): Promise<void> {
    if (this.activeLocalSession?.mode === "offline") {
      await this.cleanup();
    }
  }

  private async prepareLocalRuntime(mode: LocalMode): Promise<void> {
    if (this.activeLocalSession?.mode === mode) {
      return;
    }

    await this.cleanup();

    const serviceDir = resolveServiceDirectory(this.serverless);
    const customConfig = this.serverless.service.custom?.rolldown;
    const settings = resolveLocalExecutionSettings(
      customConfig,
      this.options,
      mode,
    );

    if (mode === "offline" && settings.watch) {
      this.ensureOfflineHandlerReload();
    }

    const functionNames =
      mode === "offline"
        ? this.serverless.service.getAllFunctions()
        : this.options.function
          ? [this.options.function]
          : [];

    if (mode === "invoke-local" && functionNames.length === 0) {
      throw new Error(
        "`serverless invoke local` requires a function name for serverless-rolldown.",
      );
    }

    const baseOutDir = resolveOutputDirectory(serviceDir, customConfig?.outDir);
    const stageOutDir = resolveStageOutDir(baseOutDir, mode);
    const relativeStageOutDir = resolveStageRelativeOutDir(
      serviceDir,
      stageOutDir,
    );
    const buildPlan = await createLocalBuildPlan({
      functionNames,
      serviceDir,
      serverless: this.serverless,
    } satisfies LocalBuildPlanRequest);

    if (buildPlan.targets.length === 0) {
      this.log(`No eligible functions found for ${mode}.`);
      return;
    }

    const snapshot = captureRuntimeSnapshot(
      this.serverless,
      buildPlan.targets.map((target) => target.functionName),
    );
    const manifestPath = getLocalManifestPath(stageOutDir);

    if (settings.skipBuild) {
      const manifest = await validateLocalBuildManifest(
        serviceDir,
        stageOutDir,
        mode,
        buildPlan.targets.map((target) => target.functionName),
      );

      if (!manifest) {
        throw new Error(
          `No reusable Rolldown build found for ${mode}. Run without --skip-build first.`,
        );
      }

      applyLocalManifest(this.serverless, manifest, serviceDir);
      this.activeLocalSession = {
        mode,
        snapshot,
        watchEnabled: false,
      };
      this.log(`Reused existing Rolldown output for ${mode}.`);
      return;
    }

    const loadedConfig = await loadPluginRolldownConfig(
      serviceDir,
      customConfig?.configFile,
    );
    this.log(
      loadedConfig.configPath
        ? `Loaded Rolldown config from ${loadedConfig.configPath}.`
        : "Using built-in Rolldown defaults.",
    );

    let manifest: LocalBuildManifest;
    let controller: LocalWatchController | undefined;

    if (settings.watch) {
      controller = new LocalWatchController({
        config: loadedConfig.config,
        configPath: loadedConfig.configPath,
        localLayers: buildPlan.localLayers,
        log: this.log.bind(this),
        mode,
        relativeStageOutDir,
        serviceDir,
        stageOutDir,
        targets: buildPlan.targets,
        usePolling: settings.usePolling,
      });
      manifest = await controller.start();
    } else {
      await rm(stageOutDir, { force: true, recursive: true });
      await writeStagePackageJson(stageOutDir);
      const stagedLayers = await stageLocalLayers(
        buildPlan.localLayers,
        stageOutDir,
      );
      await runRolldownBuilds({
        config: loadedConfig.config,
        localLayers: buildPlan.localLayers,
        outDir: stageOutDir,
        serviceDir,
        targets: buildPlan.targets.map((target) => ({
          entryFile: target.entryFile,
          entryKey: target.entryKey,
        })),
      });
      manifest = createLocalBuildManifest(
        mode,
        serviceDir,
        buildPlan.targets,
        relativeStageOutDir,
        stagedLayers,
      );
      await writeLocalBuildManifest(manifestPath, manifest);
    }

    applyLocalManifest(this.serverless, manifest, serviceDir);
    this.activeLocalSession = {
      controller,
      mode,
      snapshot,
      watchEnabled: settings.watch,
    };
    this.log(`Prepared local Rolldown output for ${mode}.`);
  }

  async cleanup(): Promise<void> {
    if (!this.activeLocalSession) {
      return;
    }

    const session = this.activeLocalSession;
    this.activeLocalSession = undefined;

    if (session.controller) {
      await session.controller.stop();
    }

    restoreRuntimeSnapshot(this.serverless, session.snapshot);
  }
}

export {
  DEFAULT_OUT_DIR,
  findRolldownConfigPath,
  loadPluginRolldownConfig,
  resolveOutputDirectory,
  runRolldownBuild,
  startRolldownWatch,
} from "./config.js";
export {
  applyLocalBuildPlan,
  applyPackagingPlan,
  createLocalBuildPlan,
  createPackagingPlan,
} from "./packaging.js";
