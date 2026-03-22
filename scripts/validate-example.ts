import { rm } from "node:fs/promises";
import path from "node:path";

const repoDir = path.resolve(import.meta.dir, "..");
const exampleDir = path.join(repoDir, "example");

async function runCommand(
  cmd: string[],
  cwd: string,
  label: string,
): Promise<void> {
  const processResult = Bun.spawn({
    cmd,
    cwd,
    env: process.env,
    stdin: "inherit",
    stderr: "inherit",
    stdout: "inherit",
  });

  const exitCode = await processResult.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}.`);
  }
}

async function cleanupStaleLocalPlugin(): Promise<void> {
  await rm(path.join(exampleDir, "node_modules", "serverless-rolldown"), {
    force: true,
    recursive: true,
  });
}

async function ensureExampleDependencies(): Promise<void> {
  const serverlessPackage = Bun.file(
    path.join(exampleDir, "node_modules", "serverless", "package.json"),
  );

  if (await serverlessPackage.exists()) {
    return;
  }

  console.log("Installing example dependencies...");
  await runCommand(["bun", "install"], exampleDir, "example install");
}

await cleanupStaleLocalPlugin();
await runCommand(["bun", "run", "build"], repoDir, "plugin build");
await ensureExampleDependencies();
await runCommand(["bun", "run", "validate"], exampleDir, "example validate");
