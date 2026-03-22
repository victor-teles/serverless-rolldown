import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

interface ServerlessBinary {
  binaryPath: string;
  exists(): boolean;
}

const exampleDir = path.resolve(import.meta.dir, "..");
const repoDir = path.resolve(exampleDir, "..");
const require = createRequire(import.meta.url);

function loadBinaryFactory(): () => ServerlessBinary {
  return require(
    path.join(exampleDir, "node_modules", "serverless", "binary.js"),
  ).getBinary as () => ServerlessBinary;
}

async function runCommand(
  cmd: string[],
  label: string,
  options: Partial<
    Bun.SpawnOptions.OptionsObject<"inherit", "inherit", "inherit">
  > = {},
): Promise<void> {
  const processResult = Bun.spawn({
    cmd,
    cwd: exampleDir,
    env: process.env,
    stdin: "inherit",
    stderr: "inherit",
    stdout: "inherit",
    ...options,
  });

  const exitCode = await processResult.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}.`);
  }
}

async function ensureServerlessBinary(): Promise<string> {
  const getBinary = loadBinaryFactory();
  const binary = getBinary();

  if (binary.exists()) {
    return binary.binaryPath;
  }

  console.error(
    "Installing the Serverless Framework binary for this example...",
  );
  await runCommand(
    [
      "bun",
      path.join(exampleDir, "node_modules", "serverless", "postInstall.js"),
    ],
    "serverless postinstall",
  );

  const installedBinary = getBinary();
  if (!installedBinary.exists()) {
    throw new Error("Serverless Framework binary installation did not finish.");
  }

  return installedBinary.binaryPath;
}

async function ensureLocalPluginEntrypoint(): Promise<void> {
  const distEntry = path.join(repoDir, "dist", "index.js");
  if (!(await Bun.file(distEntry).exists())) {
    throw new Error(
      "Missing the built plugin entrypoint. Run `bun run build` in the repo root first.",
    );
  }

  const pluginDirectory = path.join(
    exampleDir,
    "node_modules",
    "serverless-rolldown",
  );
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(
    path.join(pluginDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "serverless-rolldown",
        type: "module",
        main: "./index.js",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(pluginDirectory, "index.js"),
    [
      'export { default } from "../../../dist/index.js";',
      'export * from "../../../dist/index.js";',
      "",
    ].join("\n"),
    "utf8",
  );
}

const cliArgs = process.argv.slice(2);

if (cliArgs.length === 0) {
  throw new Error("Expected Serverless CLI arguments.");
}

await ensureLocalPluginEntrypoint();
const binaryPath = await ensureServerlessBinary();
await runCommand([binaryPath, ...cliArgs], "serverless");
