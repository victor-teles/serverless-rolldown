import { expect, test } from "bun:test";
import path from "node:path";
import {
  DEFAULT_OUT_DIR,
  findRolldownConfigPath,
  loadPluginRolldownConfig,
  resolveOutputDirectory,
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

test("defaults builds under .serverless/build", async () => {
  const serviceDir = await createTempService({});

  try {
    expect(resolveOutputDirectory(serviceDir)).toBe(
      path.join(serviceDir, DEFAULT_OUT_DIR),
    );
  } finally {
    await removeDirectory(serviceDir);
  }
});

test("reuses the Serverless framework build directory for default output", () => {
  const serviceDir = path.join(
    "/tmp",
    "serverless-rolldown",
    ".serverless",
    "build",
  );

  expect(resolveOutputDirectory(serviceDir)).toBe(serviceDir);
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
