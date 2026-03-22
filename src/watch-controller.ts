import { watch as createFileWatcher, type FSWatcher } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RolldownOptions } from "rolldown";
import { runRolldownBuilds } from "./config.js";
import { stageLocalLayers } from "./layers.js";
import {
  createLocalBuildManifest,
  getLocalManifestPath,
  type LocalBuildManifest,
  type LocalMode,
  writeLocalBuildManifest,
} from "./local-runtime.js";
import { writeStagePackageJson } from "./stages.js";
import type {
  BuildTarget,
  ResolvedLocalLayer,
  StagedLocalLayer,
} from "./types.js";

interface LocalWatchControllerOptions {
  config: RolldownOptions;
  configPath?: string;
  log(message: string): void;
  mode: LocalMode;
  relativeStageOutDir: string;
  serviceDir: string;
  stageOutDir: string;
  targets: BuildTarget[];
  usePolling?: number;
  localLayers: ResolvedLocalLayer[];
}

type PollSnapshot = Map<string, number>;

async function collectFileTimestamps(
  rootDirectory: string,
  ignoredDirectory: string,
): Promise<PollSnapshot> {
  const snapshot = new Map<string, number>();
  const directoryEntries = await readdir(rootDirectory, {
    withFileTypes: true,
  });

  for (const directoryEntry of directoryEntries) {
    const absolutePath = path.join(rootDirectory, directoryEntry.name);
    if (
      absolutePath === ignoredDirectory ||
      absolutePath.startsWith(`${ignoredDirectory}${path.sep}`)
    ) {
      continue;
    }

    if (directoryEntry.isDirectory()) {
      for (const [filePath, timestamp] of await collectFileTimestamps(
        absolutePath,
        ignoredDirectory,
      )) {
        snapshot.set(filePath, timestamp);
      }
      continue;
    }

    if (!directoryEntry.isFile()) {
      continue;
    }

    snapshot.set(absolutePath, (await stat(absolutePath)).mtimeMs);
  }

  return snapshot;
}

function snapshotsDiffer(
  leftSnapshot: PollSnapshot,
  rightSnapshot: PollSnapshot,
): boolean {
  if (leftSnapshot.size !== rightSnapshot.size) {
    return true;
  }

  for (const [filePath, timestamp] of leftSnapshot) {
    if (rightSnapshot.get(filePath) !== timestamp) {
      return true;
    }
  }

  return false;
}

export class LocalWatchController {
  private activeBuild: Promise<void> = Promise.resolve();
  private debounceTimer?: Timer;
  private fileWatchers: FSWatcher[] = [];
  private latestManifest?: LocalBuildManifest;
  private pollInterval?: Timer;
  private previousPollSnapshot?: PollSnapshot;
  private readonly options: LocalWatchControllerOptions;
  private stagedLayers: StagedLocalLayer[] = [];
  private stopped = false;

  constructor(options: LocalWatchControllerOptions) {
    this.options = options;
  }

  async start(): Promise<LocalBuildManifest> {
    await this.rebuild();
    this.previousPollSnapshot = await collectFileTimestamps(
      this.options.serviceDir,
      this.options.stageOutDir,
    );
    this.createWatchers();

    if (!this.latestManifest) {
      throw new Error("Failed to initialize the local Rolldown watcher.");
    }

    return this.latestManifest;
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    for (const fileWatcher of this.fileWatchers) {
      fileWatcher.close();
    }

    this.fileWatchers = [];
    await this.activeBuild;
  }

  private async rebuild(): Promise<void> {
    await rm(this.options.stageOutDir, { force: true, recursive: true });
    await writeStagePackageJson(this.options.stageOutDir);
    this.stagedLayers = await stageLocalLayers(
      this.options.localLayers,
      this.options.stageOutDir,
    );
    await runRolldownBuilds({
      config: this.options.config,
      localLayers: this.options.localLayers,
      outDir: this.options.stageOutDir,
      serviceDir: this.options.serviceDir,
      targets: this.options.targets.map((target) => ({
        entryFile: target.entryFile,
        entryKey: target.entryKey,
      })),
    });

    this.latestManifest = createLocalBuildManifest(
      this.options.mode,
      this.options.serviceDir,
      this.options.targets,
      this.options.relativeStageOutDir,
      this.stagedLayers,
    );
    await writeLocalBuildManifest(
      getLocalManifestPath(this.options.stageOutDir),
      this.latestManifest,
    );
  }

  private createWatchers(): void {
    const ignoredRelativeDirectory = path.relative(
      this.options.serviceDir,
      this.options.stageOutDir,
    );
    const queueRebuild = (changedPath?: string) => {
      if (
        changedPath &&
        (changedPath === ignoredRelativeDirectory ||
          changedPath.startsWith(`${ignoredRelativeDirectory}${path.sep}`))
      ) {
        return;
      }

      this.scheduleRebuild(
        `Rebuilding ${this.options.mode} Rolldown output after source changes.`,
      );
    };

    const pollInterval = this.options.usePolling ?? 200;
    this.pollInterval = setInterval(() => {
      void collectFileTimestamps(
        this.options.serviceDir,
        this.options.stageOutDir,
      ).then((snapshot) => {
        if (
          this.previousPollSnapshot &&
          snapshotsDiffer(this.previousPollSnapshot, snapshot)
        ) {
          this.previousPollSnapshot = snapshot;
          queueRebuild();
          return;
        }

        this.previousPollSnapshot = snapshot;
      });
    }, pollInterval);

    try {
      this.fileWatchers.push(
        createFileWatcher(
          this.options.serviceDir,
          { recursive: true },
          (_, fileName) => {
            queueRebuild(fileName ? String(fileName) : undefined);
          },
        ),
      );
    } catch {
      const watchDirectories = new Set<string>([
        this.options.serviceDir,
        ...this.options.targets.map((target) => path.dirname(target.entryFile)),
        ...this.options.localLayers.map((layer) => layer.sourcePath),
      ]);

      if (this.options.configPath) {
        watchDirectories.add(path.dirname(this.options.configPath));
      }

      for (const watchDirectory of watchDirectories) {
        this.fileWatchers.push(
          createFileWatcher(watchDirectory, (_, fileName) => {
            queueRebuild(fileName ? String(fileName) : undefined);
          }),
        );
      }
    }
  }

  private scheduleRebuild(message: string): void {
    if (this.stopped) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.activeBuild = this.activeBuild
        .then(async () => {
          if (this.stopped) {
            return;
          }

          this.options.log(message);
          await this.rebuild();
        })
        .catch((error) => {
          this.options.log(
            `Rolldown rebuild failed in ${this.options.mode}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }, 50);
  }
}
