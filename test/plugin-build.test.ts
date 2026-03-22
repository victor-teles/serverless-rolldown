import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OUT_DIR } from "../src/config";
import ServerlessRolldown from "../src/serverless-rolldown";
import {
  copyFixture,
  createServerlessMock,
  pathExists,
  removeDirectory,
} from "./helpers";

test("bundles service packages in one multi-entry build with shared chunks", async () => {
  const serviceDir = await copyFixture("service");
  const serverless = createServerlessMock({
    functions: {
      bar: { handler: "src/bar.handler" },
      foo: { handler: "src/foo.handler" },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
    servicePackage: {
      patterns: ["assets/**", "!ignored/**"],
    },
  });
  const plugin = new ServerlessRolldown(serverless, {});

  try {
    await plugin.hooks["before:package:createDeploymentArtifacts"]?.();

    expect(
      await pathExists(
        path.join(
          serviceDir,
          DEFAULT_OUT_DIR,
          "package",
          "functions",
          "foo",
          "index.js",
        ),
      ),
    ).toBeTrue();
    expect(
      await pathExists(
        path.join(
          serviceDir,
          DEFAULT_OUT_DIR,
          "package",
          "functions",
          "bar",
          "index.js",
        ),
      ),
    ).toBeTrue();
    expect(
      await readdir(
        path.join(serviceDir, DEFAULT_OUT_DIR, "package", "_chunks"),
      ),
    ).not.toHaveLength(0);
    expect(
      await readFile(
        path.join(serviceDir, DEFAULT_OUT_DIR, "package", "package.json"),
        "utf8",
      ),
    ).toContain('"type": "commonjs"');
    expect(serverless.service.getFunction("foo").handler).toBe(
      `${DEFAULT_OUT_DIR}/package/functions/foo/index.handler`,
    );
    expect(serverless.service.package?.patterns).toEqual([
      "!**",
      `${DEFAULT_OUT_DIR}/package/**`,
      "assets/**",
    ]);
  } finally {
    await removeDirectory(serviceDir);
  }
});

test("bundles deploy function targets as self-contained outputs", async () => {
  const serviceDir = await copyFixture("service");
  const serverless = createServerlessMock({
    functions: {
      bar: { handler: "src/bar.handler" },
      foo: {
        handler: "src/foo.handler",
        package: {
          patterns: ["fixtures/**", "!tmp/**"],
        },
      },
    },
    providerRuntime: "nodejs20.x",
    serviceDir,
    servicePackage: {
      patterns: ["shared/**"],
    },
  });
  const plugin = new ServerlessRolldown(serverless, { function: "foo" });

  try {
    await plugin.hooks["before:deploy:function:packageFunction"]?.();

    expect(
      await pathExists(
        path.join(
          serviceDir,
          DEFAULT_OUT_DIR,
          "package",
          "functions",
          "foo",
          "index.js",
        ),
      ),
    ).toBeTrue();
    expect(
      await pathExists(
        path.join(serviceDir, DEFAULT_OUT_DIR, "package", "_chunks"),
      ),
    ).toBeFalse();
    expect(
      await readFile(
        path.join(serviceDir, DEFAULT_OUT_DIR, "package", "package.json"),
        "utf8",
      ),
    ).toContain('"type": "commonjs"');
    expect(serverless.service.getFunction("foo").handler).toBe(
      `${DEFAULT_OUT_DIR}/package/functions/foo/index.handler`,
    );
    expect(serverless.service.getFunction("bar").handler).toBe(
      "src/bar.handler",
    );
    expect(serverless.service.getFunction("foo").package?.patterns).toEqual([
      "!**",
      `${DEFAULT_OUT_DIR}/package/functions/foo/**`,
      "shared/**",
      "fixtures/**",
    ]);
  } finally {
    await removeDirectory(serviceDir);
  }
});
