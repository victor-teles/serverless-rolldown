import { expect, test } from "bun:test";
import { DEFAULT_OUT_DIR } from "../src/config";
import { applyPackagingPlan, createPackagingPlan } from "../src/packaging";
import {
	createServerlessMock,
	createTempService,
	removeDirectory,
} from "./helpers";

test("collects eligible service-level targets and narrows service package patterns", async () => {
	const serviceDir = await createTempService({
		"src/api.ts": "export const handler = () => 'api';\n",
		"src/worker.ts": "export const handler = () => 'worker';\n",
	});
	const serverless = createServerlessMock({
		functions: {
			api: { handler: "src/api.handler" },
			imageFn: { image: "123.dkr.ecr/image" },
			invalid: { handler: undefined },
			pythonFn: { handler: "src/worker.handler", runtime: "python3.12" },
			worker: { handler: "src/worker.handler" },
		},
		providerRuntime: "nodejs20.x",
		serviceDir,
		servicePackage: {
			patterns: ["assets/**", "!ignored/**"],
		},
	});

	try {
		const plan = await createPackagingPlan({
			options: {},
			outDir: DEFAULT_OUT_DIR,
			serviceDir,
			serverless,
		});

		expect(plan.serviceTargets.map((target) => target.functionName)).toEqual([
			"api",
			"worker",
		]);
		expect(plan.individualTargets).toHaveLength(0);

		applyPackagingPlan(serverless, plan, DEFAULT_OUT_DIR);

		expect(serverless.service.getFunction("api").handler).toBe(
			"serverless-rolldown-build/functions/api/index.handler",
		);
		expect(serverless.service.getFunction("worker").handler).toBe(
			"serverless-rolldown-build/functions/worker/index.handler",
		);
		expect(serverless.service.package?.patterns).toEqual([
			"!**",
			"serverless-rolldown-build/**",
			"assets/**",
		]);
	} finally {
		await removeDirectory(serviceDir);
	}
});

test("builds individual targets when packaging a single function", async () => {
	const serviceDir = await createTempService({
		"src/foo.ts": "export const handler = () => 'foo';\n",
		"src/bar.ts": "export const handler = () => 'bar';\n",
	});
	const serverless = createServerlessMock({
		functions: {
			bar: { handler: "src/bar.handler" },
			foo: {
				handler: "src/foo.handler",
				package: {
					artifact: "existing.zip",
					patterns: ["fixtures/**", "!tmp/**"],
				},
			},
		},
		providerRuntime: "nodejs20.x",
		serviceDir,
		servicePackage: {
			individually: true,
			patterns: ["shared/**"],
		},
	});

	try {
		const plan = await createPackagingPlan({
			options: { function: "bar" },
			outDir: DEFAULT_OUT_DIR,
			serviceDir,
			serverless,
		});

		expect(plan.individualTargets.map((target) => target.functionName)).toEqual(
			["bar"],
		);
		expect(plan.serviceTargets).toHaveLength(0);

		applyPackagingPlan(serverless, plan, DEFAULT_OUT_DIR);

		expect(serverless.service.getFunction("bar").handler).toBe(
			"serverless-rolldown-build/functions/bar/index.handler",
		);
		expect(serverless.service.getFunction("bar").package?.patterns).toEqual([
			"!**",
			"serverless-rolldown-build/functions/bar/**",
			"shared/**",
		]);
		expect(serverless.service.getFunction("foo").handler).toBe(
			"src/foo.handler",
		);
	} finally {
		await removeDirectory(serviceDir);
	}
});
