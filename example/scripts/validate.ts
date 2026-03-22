import { access, rm } from "node:fs/promises";
import path from "node:path";

const exampleDir = path.resolve(import.meta.dir, "..");
const buildDir = path.join(exampleDir, ".serverless", "build");
const packageBuildDirectories = [
  path.join(buildDir, "package"),
  path.join(buildDir, ".serverless", "build", "package"),
];
const localInvokeBuildDirectories = [
  path.join(buildDir, "invoke-local"),
  path.join(buildDir, ".serverless", "build", "invoke-local"),
];

async function runCommand(
  cmd: string[],
  label: string,
): Promise<{ stderr: string; stdout: string }> {
  const processResult = Bun.spawn({
    cmd,
    cwd: exampleDir,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  if (stdout) {
    process.stdout.write(stdout);
  }

  if (stderr) {
    process.stderr.write(stderr);
  }

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}.`);
  }

  return { stderr, stdout };
}

async function assertPathExistsInAny(targetPaths: string[]): Promise<string> {
  for (const targetPath of targetPaths) {
    try {
      await access(targetPath);
      return targetPath;
    } catch {
      // Try the next candidate path.
    }
  }

  throw new Error(
    `Expected one of these paths to exist:\n${targetPaths
      .map((targetPath) => `- ${path.relative(exampleDir, targetPath)}`)
      .join("\n")}`,
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertPathsDoNotExist(targetPaths: string[]): Promise<void> {
  for (const targetPath of targetPaths) {
    if (await pathExists(targetPath)) {
      throw new Error(
        `Expected path to be absent: ${path.relative(exampleDir, targetPath)}`,
      );
    }
  }
}

function assertOutputContains(output: string, expectedText: string): void {
  if (!output.includes(expectedText)) {
    throw new Error(
      `Expected invoke output to include "${expectedText}", received:\n${output}`,
    );
  }
}

async function runBuiltHandler(builtFile: string): Promise<string> {
  const executionResult = await runCommand(
    [
      "node",
      "-e",
      [
        `const mod = require(${JSON.stringify(builtFile)});`,
        "Promise.resolve(mod.handler())",
        "  .then((value) => { process.stdout.write(String(value)); })",
        "  .catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"),
    ],
    "execute built handler",
  );

  return executionResult.stdout;
}

async function main(): Promise<void> {
  await rm(buildDir, { force: true, recursive: true });

  console.log("Running package smoke validation...");
  await runCommand(["bun", "run", "package"], "package");

  await assertPathExistsInAny(
    packageBuildDirectories.map((packageBuildDir) =>
      path.join(packageBuildDir, "functions", "hello", "index.js"),
    ),
  );
  const goodbyeBuildFile = await assertPathExistsInAny(
    packageBuildDirectories.map((packageBuildDir) =>
      path.join(packageBuildDir, "functions", "goodbye", "index.js"),
    ),
  );
  await assertPathsDoNotExist(
    packageBuildDirectories.map((packageBuildDir) =>
      path.join(packageBuildDir, "_chunks"),
    ),
  );

  console.log("Running packaged AWS SDK smoke validation...");
  assertOutputContains(
    await runBuiltHandler(goodbyeBuildFile),
    "goodbye:shared-smoke",
  );

  console.log("Running invoke-local smoke validation...");
  const invokeResult = await runCommand(
    ["bun", "run", "invoke:hello"],
    "invoke:hello",
  );

  await assertPathExistsInAny(
    localInvokeBuildDirectories.map((localInvokeBuildDir) =>
      path.join(localInvokeBuildDir, "functions", "hello", "index.js"),
    ),
  );
  assertOutputContains(invokeResult.stdout, "hello:shared-smoke");

  console.log("Example validation passed.");
}

await main();
