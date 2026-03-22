import { expect, test } from "bun:test";
import path from "node:path";
import {
  createLocalLayerImportMatcher,
  discoverLocalLayers,
  stageLocalLayers,
} from "../src/layers";
import {
  createServerlessMock,
  createTempService,
  pathExists,
  removeDirectory,
} from "./helpers";

test("discovers referenced local layers and stages them for local execution", async () => {
  const serviceDir = await createTempService({
    "layers/shared/nodejs/node_modules/layer-lib/index.js":
      "module.exports = { value: 'shared' };\n",
    "layers/shared/nodejs/util.js": "module.exports = 'util';\n",
    "src/handler.ts": "export const handler = () => 'ok';\n",
  });
  const serverless = createServerlessMock({
    functions: {
      foo: {
        handler: "src/handler.handler",
        layers: [
          "shared",
          "arn:aws:lambda:us-east-1:123456789012:layer:base:1",
          "missing",
        ],
      },
    },
    layers: {
      missing: {},
      shared: { path: "layers/shared" },
      unused: { path: "layers/unused" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
  });
  const stageOutDir = path.join(serviceDir, ".stage");

  try {
    const layers = await discoverLocalLayers(serverless, ["foo"], serviceDir);

    expect(layers).toHaveLength(1);
    expect(layers[0]?.layerName).toBe("shared");
    expect(layers[0]?.nodePaths).toEqual([
      path.join(serviceDir, "layers", "shared", "nodejs", "node_modules"),
      path.join(serviceDir, "layers", "shared", "nodejs"),
    ]);

    const stagedLayers = await stageLocalLayers(layers, stageOutDir);
    expect(stagedLayers).toHaveLength(1);
    expect(stagedLayers[0]?.stageNodePaths).toEqual([
      path.join(stageOutDir, "layers", "shared", "nodejs", "node_modules"),
      path.join(stageOutDir, "layers", "shared", "nodejs"),
    ]);
    expect(
      await pathExists(
        path.join(
          stageOutDir,
          "layers",
          "shared",
          "nodejs",
          "node_modules",
          "layer-lib",
          "index.js",
        ),
      ),
    ).toBeTrue();
  } finally {
    await removeDirectory(serviceDir);
  }
});

test("matches bare imports that resolve from discovered local layer paths", async () => {
  const serviceDir = await createTempService({
    "layers/shared/nodejs/node_modules/layer-lib/index.js":
      "module.exports = { value: 'shared' };\n",
    "src/handler.ts": "export const handler = () => 'ok';\n",
  });
  const serverless = createServerlessMock({
    functions: {
      foo: {
        handler: "src/handler.handler",
        layers: ["shared"],
      },
    },
    layers: {
      shared: { path: "layers/shared" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
  });

  try {
    const layers = await discoverLocalLayers(serverless, ["foo"], serviceDir);
    const matcher = createLocalLayerImportMatcher(serviceDir, layers);

    expect(matcher("layer-lib")).toBeTrue();
    expect(matcher("./layer-lib")).toBeFalse();
    expect(matcher("missing-layer-lib")).toBeFalse();
  } finally {
    await removeDirectory(serviceDir);
  }
});
