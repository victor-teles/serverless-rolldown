import { expect, test } from "bun:test";
import {
  captureRuntimeSnapshot,
  resolveLocalExecutionSettings,
  restoreRuntimeSnapshot,
} from "../src/local-runtime";
import {
  createServerlessMock,
  createTempService,
  removeDirectory,
} from "./helpers";

test("resolves watch, polling, and skip-build settings for local modes", () => {
  expect(
    resolveLocalExecutionSettings(
      {
        noBuild: false,
        noWatch: false,
        usePolling: 2000,
      },
      {
        rolldownUsePolling: "4500",
        watch: true,
      },
      "invoke-local",
    ),
  ).toEqual({
    skipBuild: false,
    usePolling: 4500,
    watch: true,
  });

  expect(
    resolveLocalExecutionSettings(
      {
        noBuild: true,
      },
      {
        watch: true,
      },
      "offline",
    ),
  ).toEqual({
    skipBuild: true,
    usePolling: undefined,
    watch: false,
  });
});

test("captures and restores runtime handler and NODE_PATH state", async () => {
  const serviceDir = await createTempService({
    "src/handler.ts": "export const handler = () => 'ok';\n",
  });
  const serverless = createServerlessMock({
    functions: {
      foo: { handler: "src/handler.handler" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
  });
  const originalNodePath = process.env.NODE_PATH;

  try {
    process.env.NODE_PATH = "original-node-path";
    const snapshot = captureRuntimeSnapshot(serverless, ["foo"]);

    serverless.service.getFunction("foo").handler = "changed.handler";
    process.env.NODE_PATH = "changed-node-path";

    restoreRuntimeSnapshot(serverless, snapshot);

    expect(serverless.service.getFunction("foo").handler).toBe(
      "src/handler.handler",
    );
    expect(process.env.NODE_PATH).toBe("original-node-path");
  } finally {
    if (originalNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = originalNodePath;
    }

    await removeDirectory(serviceDir);
  }
});
