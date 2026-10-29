import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_VERSION } from "../src/constants";

describe("release identity", () => {
	test("extension metadata reports the package version", () => {
		const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			version: string;
		};
		expect(EXTENSION_VERSION).toBe(packageJson.version);
	});
});
