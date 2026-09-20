import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  collectImagesFromSse,
  generateAntigravityImage,
  resolveImageSavePath,
} from "../src/image/image.js";

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

describe("image SSE final frame", () => {
  it("parses an unterminated final data line at EOF", async () => {
    const payload = {
      response: {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
            },
          },
        ],
      },
    };
    const parsed = await collectImagesFromSse(
      new Response(`data: ${JSON.stringify(payload)}`, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.images[0]?.data, "aGVsbG8=");
  });
});

describe("generateAntigravityImage symlink ancestor safety", () => {
  it("saves an image at the requested nested file path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-img-nested-"));
    const cwd = join(root, "workspace");
    await mkdir(cwd);

    const payload = {
      response: {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
            },
          },
        ],
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(`data: ${JSON.stringify(payload)}\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;

    try {
      const result = await generateAntigravityImage({
        prompt: "A test image",
        path: "nested/output.png",
        cwd,
        apiKey: JSON.stringify({ token: "token", projectId: "project" }),
      });
      assert.deepEqual(result.savedPaths, [join(cwd, "nested", "output.png")]);
      assert.equal((await readFile(join(cwd, "nested", "output.png"))).toString(), "hello");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink ancestors before network access or outside mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-img-symlink-"));
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await symlink(outside, join(cwd, "link"), "dir");

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
            path: "link/new-folder/image.png",
            cwd,
            apiKey: JSON.stringify({ token: "token", projectId: "project" }),
          }),
        /symlink traversal/,
      );
      assert.equal(requests, 0);
      await assert.rejects(access(join(outside, "new-folder")));
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
