import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateAntigravityImage, resolveImageSavePath } from "../src/image/image.js";

const CWD = "/tmp/agy-img-test";

describe("resolveImageSavePath", () => {
  it("generates a default path inside .omp/generated-images", () => {
    const p = resolveImageSavePath(CWD);
    assert.ok(p.startsWith(`${CWD}/.omp/generated-images/`));
    assert.ok(p.endsWith(".png"));
  });

  it("rejects paths escaping the working directory", () => {
    assert.throws(() => resolveImageSavePath(CWD, "../escape.png"), /inside the working directory/);
    assert.throws(() => resolveImageSavePath(CWD, "/etc/passwd"), /inside the working directory/);
  });

  it("treats '.' (the working directory itself) as a directory target", () => {
    const p = resolveImageSavePath(CWD, ".");
    assert.ok(p.startsWith(`${CWD}/.omp/generated-images/`) || p.startsWith(`${CWD}/image-`));
  });

  it("honours an explicit file path and appends index suffixes", () => {
    const p = resolveImageSavePath(CWD, "out/pic.png", "image/png", 1);
    assert.equal(p, `${CWD}/out/pic-2.png`);
  });
});

describe("generateAntigravityImage input validation", () => {
  it("rejects an escaping output path before making a generation request", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("network must not be reached");
    }) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          generateAntigravityImage({
            prompt: "A test image",
            path: "../escape.png",
            cwd: CWD,
            apiKey: JSON.stringify({ token: "token", projectId: "project" }),
          }),
        /inside the working directory/,
      );
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
