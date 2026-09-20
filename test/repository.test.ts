import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("repository script integrity", () => {
  it("does not reference missing local files or undefined bun scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    for (const [name, command] of Object.entries(scripts)) {
      for (const match of command.matchAll(/\bbun\s+run\s+([A-Za-z0-9:_-]+)/g)) {
        const target = match[1];
        assert.ok(target && scripts[target], `${name} references undefined script "${target}"`);
      }
      for (const match of command.matchAll(
        /\b(?:bun|node)\s+((?:\.\/)?(?:scripts|test|src)\/[^\s;&|]+)/g,
      )) {
        const relativePath = match[1]?.replace(/^\.\//, "");
        assert.ok(
          relativePath && existsSync(join(repoRoot, relativePath)),
          `${name} references missing local file "${relativePath ?? "unknown"}"`,
        );
      }
    }
  });
});
