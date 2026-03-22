import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OUT_DIR } from "../src/config";
import ServerlessRolldown from "../src/serverless-rolldown";
import {
  createServerlessMock,
  createTempService,
  pathExists,
  removeDirectory,
  runBuiltHandlerWithNode,
  waitFor,
} from "./helpers";

async function builtFileContains(
  filePath: string,
  text: string,
): Promise<boolean> {
  try {
    return (await readFile(filePath, "utf8")).includes(text);
  } catch {
    return false;
  }
}

test("invoke local builds one-shot output, resolves staged layer imports, and restores runtime state", async () => {
  const serviceDir = await createTempService({
    "layers/shared/nodejs/node_modules/layer-lib/index.js":
      "module.exports = { handlerValue: 'from-layer' };\n",
    "src/handler.ts": `
const { handlerValue } = require("layer-lib");
export async function handler() {
	return handlerValue;
}
`,
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
  const plugin = new ServerlessRolldown(serverless, { function: "foo" });
  const originalNodePath = process.env.NODE_PATH;

  try {
    await plugin.hooks["before:invoke:local:invoke"]?.();

    const builtFile = path.join(
      serviceDir,
      DEFAULT_OUT_DIR,
      "invoke-local",
      "functions",
      "foo",
      "index.js",
    );
    expect(await pathExists(builtFile)).toBeTrue();
    expect(
      await readFile(
        path.join(serviceDir, DEFAULT_OUT_DIR, "invoke-local", "package.json"),
        "utf8",
      ),
    ).toContain('"type": "commonjs"');
    expect(serverless.service.getFunction("foo").handler).toBe(
      `${DEFAULT_OUT_DIR}/invoke-local/functions/foo/index.handler`,
    );
    expect(process.env.NODE_PATH).toContain(
      path.join(
        serviceDir,
        DEFAULT_OUT_DIR,
        "invoke-local",
        "layers",
        "shared",
        "nodejs",
        "node_modules",
      ),
    );
    expect(await readFile(builtFile, "utf8")).toContain("layer-lib");

    const executionResult = await runBuiltHandlerWithNode(
      builtFile,
      process.env.NODE_PATH,
    );
    expect(executionResult.stderr).toBe("");
    expect(executionResult.stdout).toBe("from-layer");

    await plugin.hooks["after:invoke:local:invoke"]?.();

    expect(serverless.service.getFunction("foo").handler).toBe(
      "src/handler.handler",
    );
    expect(process.env.NODE_PATH).toBe(originalNodePath);
  } finally {
    if (originalNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = originalNodePath;
    }

    await plugin.cleanup();
    await removeDirectory(serviceDir);
  }
});

test("invoke local --watch keeps a persistent watcher and rebuilds on source change", async () => {
  const serviceDir = await createTempService({
    "src/watch.ts": `
export async function handler() {
	return "before";
}
`,
  });
  const serverless = createServerlessMock({
    functions: {
      foo: { handler: "src/watch.handler" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
  });
  const plugin = new ServerlessRolldown(serverless, {
    function: "foo",
    watch: true,
  });
  const builtFile = path.join(
    serviceDir,
    DEFAULT_OUT_DIR,
    "invoke-local",
    "functions",
    "foo",
    "index.js",
  );

  try {
    await plugin.hooks["before:invoke:local:invoke"]?.();
    await waitFor(async () => builtFileContains(builtFile, "before"), {
      timeoutMs: 5000,
    });

    await writeFile(
      path.join(serviceDir, "src", "watch.ts"),
      `
export async function handler() {
	return "after";
}
`,
      "utf8",
    );

    await waitFor(async () => builtFileContains(builtFile, "after"), {
      timeoutMs: 5000,
    });
    expect(serverless.service.getFunction("foo").handler).toBe(
      `${DEFAULT_OUT_DIR}/invoke-local/functions/foo/index.handler`,
    );
  } finally {
    await plugin.cleanup();
    await removeDirectory(serviceDir);
  }
}, 15000);

test("invoke local --skip-build reuses the previous manifest output", async () => {
  const serviceDir = await createTempService({
    "src/handler.ts": `
export async function handler() {
	return "stable";
}
`,
  });
  const serverless = createServerlessMock({
    functions: {
      foo: { handler: "src/handler.handler" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
  });
  const warmupPlugin = new ServerlessRolldown(serverless, { function: "foo" });
  const reusePlugin = new ServerlessRolldown(serverless, {
    function: "foo",
    skipBuild: true,
  });

  try {
    await warmupPlugin.hooks["before:invoke:local:invoke"]?.();
    await warmupPlugin.hooks["after:invoke:local:invoke"]?.();

    await writeFile(
      path.join(serviceDir, "src", "handler.ts"),
      "export async function handler() { return ;",
      "utf8",
    );

    await reusePlugin.hooks["before:invoke:local:invoke"]?.();

    expect(serverless.service.getFunction("foo").handler).toBe(
      `${DEFAULT_OUT_DIR}/invoke-local/functions/foo/index.handler`,
    );
    expect(
      await readFile(
        path.join(
          serviceDir,
          DEFAULT_OUT_DIR,
          "invoke-local",
          "functions",
          "foo",
          "index.js",
        ),
        "utf8",
      ),
    ).toContain("stable");

    await reusePlugin.hooks["after:invoke:local:invoke"]?.();
    expect(serverless.service.getFunction("foo").handler).toBe(
      "src/handler.handler",
    );
  } finally {
    await warmupPlugin.cleanup();
    await reusePlugin.cleanup();
    await removeDirectory(serviceDir);
  }
});

test("serverless-offline prepares multi-function watched outputs and restores runtime state on stop", async () => {
  const serviceDir = await createTempService({
    "src/foo.ts": `
import { buildMessage } from "./shared";

export async function handler() {
	return buildMessage("foo");
}
`,
    "src/bar.ts": `
import { buildMessage } from "./shared";

export async function handler() {
	return buildMessage("bar");
}
`,
    "src/shared.ts": `
export function buildMessage(name: string) {
	return \`\${name}:offline-before\`;
}
`,
  });
  const serverless = createServerlessMock({
    functions: {
      bar: { handler: "src/bar.handler" },
      foo: { handler: "src/foo.handler" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
  });
  const plugin = new ServerlessRolldown(serverless, {});
  const fooBuiltFile = path.join(
    serviceDir,
    DEFAULT_OUT_DIR,
    "offline",
    "functions",
    "foo",
    "index.js",
  );
  const barBuiltFile = path.join(
    serviceDir,
    DEFAULT_OUT_DIR,
    "offline",
    "functions",
    "bar",
    "index.js",
  );

  try {
    await plugin.hooks["before:offline:start:init"]?.();

    expect(serverless.service.custom?.["serverless-offline"]).toEqual({
      reloadHandler: true,
    });

    expect(serverless.service.getFunction("foo").handler).toBe(
      `${DEFAULT_OUT_DIR}/offline/functions/foo/index.handler`,
    );
    expect(serverless.service.getFunction("bar").handler).toBe(
      `${DEFAULT_OUT_DIR}/offline/functions/bar/index.handler`,
    );
    expect(
      await pathExists(
        path.join(serviceDir, DEFAULT_OUT_DIR, "offline", "_chunks"),
      ),
    ).toBeFalse();
    await waitFor(
      async () => builtFileContains(fooBuiltFile, "offline-before"),
      {
        timeoutMs: 5000,
      },
    );
    await waitFor(
      async () => builtFileContains(barBuiltFile, "offline-before"),
      {
        timeoutMs: 5000,
      },
    );
    expect(await runBuiltHandlerWithNode(fooBuiltFile)).toEqual({
      stderr: "",
      stdout: "foo:offline-before",
    });
    expect(await runBuiltHandlerWithNode(barBuiltFile)).toEqual({
      stderr: "",
      stdout: "bar:offline-before",
    });

    await writeFile(
      path.join(serviceDir, "src", "shared.ts"),
      `
export function buildMessage(name: string) {
	return \`\${name}:offline-after\`;
}
`,
      "utf8",
    );

    await waitFor(
      async () => builtFileContains(fooBuiltFile, "offline-after"),
      {
        timeoutMs: 5000,
      },
    );
    await waitFor(
      async () => builtFileContains(barBuiltFile, "offline-after"),
      {
        timeoutMs: 5000,
      },
    );
    expect(await runBuiltHandlerWithNode(fooBuiltFile)).toEqual({
      stderr: "",
      stdout: "foo:offline-after",
    });
    expect(await runBuiltHandlerWithNode(barBuiltFile)).toEqual({
      stderr: "",
      stdout: "bar:offline-after",
    });

    await plugin.hooks["offline:start:end"]?.();
    expect(serverless.service.getFunction("foo").handler).toBe(
      "src/foo.handler",
    );
    expect(serverless.service.getFunction("bar").handler).toBe(
      "src/bar.handler",
    );
  } finally {
    await plugin.cleanup();
    await removeDirectory(serviceDir);
  }
}, 15000);
