import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writePrivateFileNoFollow } from "../src/utils/security.js";

describe("writePrivateFileNoFollow", () => {
  it("does not overwrite the target of a final-path symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "antigravity-secure-write-"));
    const target = join(dir, "target.txt");
    const link = join(dir, "dump.json");
    await writeFile(target, "original", "utf8");
    await symlink(target, link);

    try {
      await assert.rejects(() => writePrivateFileNoFollow(link, "sensitive"));
      assert.equal(await readFile(target, "utf8"), "original");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
