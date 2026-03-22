import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toPosixPath } from "./paths.js";

export type StageMode = "invoke-local" | "offline" | "package";

const STAGE_DIRECTORIES: Record<StageMode, string> = {
  "invoke-local": "invoke-local",
  offline: "offline",
  package: "package",
};
const COMMON_JS_STAGE_PACKAGE = `${JSON.stringify(
  { type: "commonjs" },
  null,
  2,
)}\n`;

export function resolveStageOutDir(
  baseOutDir: string,
  mode: StageMode,
): string {
  return path.join(baseOutDir, STAGE_DIRECTORIES[mode]);
}

export function resolveStageRelativeOutDir(
  serviceDir: string,
  stageOutDir: string,
): string {
  const relativePath = path.relative(serviceDir, stageOutDir);
  return toPosixPath(relativePath || path.basename(stageOutDir));
}

export async function writeStagePackageJson(
  stageOutDir: string,
): Promise<void> {
  await mkdir(stageOutDir, { recursive: true });
  await writeFile(
    path.join(stageOutDir, "package.json"),
    COMMON_JS_STAGE_PACKAGE,
    "utf8",
  );
}
