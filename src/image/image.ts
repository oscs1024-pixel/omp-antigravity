import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AntigravityHttpError,
  antigravityHeaders,
  defaultProjectId,
  endpointCandidates,
  isRetryableEndpointStatus,
  isPlaceholderProjectId,
  jsonOrTextError,
  loadCodeAssist,
  parseApiKey,
  recordSuccessfulEndpoint,
} from "../client/client.js";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { AntigravityRequestType, AntigravityUserAgent, GeminiRole } from "../types/enums.js";
import { streamChunkError } from "../stream/errors.js";
import { antigravityFetch, withDeadline } from "../utils/http.js";
import { safeError, writePrivateFileNoFollow } from "../utils/security.js";
import { antigravityRequestEnvelope, sanitizeText } from "../utils/util.js";

export const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image";
export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

const IMAGE_MODEL_FALLBACKS = [
  DEFAULT_IMAGE_MODEL,
  "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview",
];
/**
 * Deadline for one image-generation attempt, covering the whole SSE body.
 *
 * The slash-command path passes no signal at all, so without this a stalled
 * endpoint would leave `/antigravity.image` hanging forever. Image models are
 * slow but not two-minutes-slow for a single frame.
 */
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;
const IMAGE_SYSTEM_INSTRUCTION =
  "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";
/**
 * Project-local output directory for generated images.
 *
 * OMP's project config directory is `.omp` (pi used `.pi`), so generated images
 * land in `.omp/generated-images` next to the rest of the project-local state.
 */
export const DEFAULT_IMAGE_DIR = join(".omp", "generated-images");
const MAX_PROMPT_CHARS = 8000;

export type GeneratedImage = { data: string; mimeType: string };

export type ImageGenerateRequest = {
  project: string;
  model: string;
  request: {
    contents: Array<{ role: GeminiRole.User; parts: Array<{ text: string }> }>;
    systemInstruction: { role: GeminiRole.User; parts: Array<{ text: string }> };
    generationConfig: {
      imageConfig: { aspectRatio: string };
      candidateCount: number;
    };
  };
  requestType: AntigravityRequestType.Agent;
  userAgent: AntigravityUserAgent.Antigravity;
  requestId: string;
};

export type ImageCommandArgs = {
  prompt: string;
  aspectRatio?: string;
  model?: string;
  path?: string;
};

export type GenerateImageOptions = ImageCommandArgs & {
  apiKey: string;
  cwd: string;
  signal?: AbortSignal;
};

export type GenerateImageResult = {
  images: GeneratedImage[];
  savedPaths: string[];
  text: string[];
  model: string;
};

type ImageStreamChunk = {
  error?: { message?: string; code?: number; status?: string };
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
      };
    }>;
  };
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
  }>;
};

class ImageSaveError extends Error {
  constructor(cause: unknown) {
    super(`Image save failed: ${safeError(cause)}`, { cause });
    this.name = "ImageSaveError";
  }
}

function imageExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

export function assertSafeImageModel(modelId: string): string {
  const id = modelId.trim();
  if (id.length === 0 || id.length > 80) {
    throw new Error("Unsupported image model id.");
  }
  if (!/^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(id)) {
    throw new Error(`Unsupported image model: ${id}`);
  }
  return id;
}

export function assertSafeAspectRatio(ratio: string): ImageAspectRatio {
  const value = ratio.trim();
  for (const allowed of IMAGE_ASPECT_RATIOS) {
    if (allowed === value) return allowed;
  }
  throw new Error(
    `Unsupported aspect ratio: ${value}. Use one of ${IMAGE_ASPECT_RATIOS.join(", ")}.`,
  );
}

export function parseImageCommandArgs(args: string): ImageCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: ImageCommandArgs = { prompt: "" };
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];
    if ((token === "--ratio" || token === "--aspect-ratio") && next) {
      out.aspectRatio = next;
      i += 1;
      continue;
    }
    if (token === "--model" && next) {
      out.model = next;
      i += 1;
      continue;
    }
    if (token === "--path" && next) {
      out.path = next;
      i += 1;
      continue;
    }
    rest.push(token);
  }
  out.prompt = rest.join(" ");
  return out;
}

export function resolveImageSavePath(
  cwd: string,
  requested?: string,
  mimeType = "image/png",
  index?: number,
): string {
  const ext = imageExtension(mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = index === undefined ? "" : `-${index + 1}`;
  const defaultName = `image-${stamp}${suffix}.${ext}`;
  const root = resolve(cwd);
  const target = requested?.trim()
    ? resolve(root, requested.trim())
    : resolve(root, DEFAULT_IMAGE_DIR, defaultName);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Image save path must be inside the working directory.");
  }
  if (!rel || !extname(target)) return join(target, defaultName);
  if (index === undefined) return target;
  const currentExt = extname(target);
  return `${target.slice(0, -currentExt.length)}${suffix}${currentExt}`;
}

export function buildImageGenerateRequest(
  prompt: string,
  model: string,
  projectId: string,
  aspectRatio: string,
): ImageGenerateRequest {
  const envelope = antigravityRequestEnvelope(model, false);
  return {
    project: projectId,
    model,
    request: {
      contents: [{ role: GeminiRole.User, parts: [{ text: sanitizeText(prompt) }] }],
      systemInstruction: {
        role: GeminiRole.User,
        parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }],
      },
      generationConfig: {
        imageConfig: { aspectRatio },
        candidateCount: 1,
      },
    },
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}

function collectImagesFromParts(
  parts: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> | undefined,
  images: GeneratedImage[],
  text: string[],
): void {
  for (const part of parts || []) {
    if (part.text) text.push(part.text);
    if (part.inlineData?.data) {
      images.push({
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      });
    }
  }
}

export async function collectImagesFromSse(
  response: Response,
  signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; text: string[] }> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanStart = 0;
  const images: GeneratedImage[] = [];
  const text: string[] = [];
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        if (buffer && !buffer.endsWith("\n")) buffer += "\n";
      } else {
        if (!(result.value instanceof Uint8Array)) continue;
        buffer += decoder.decode(result.value, { stream: true });
      }
      // Incremental scan (same pattern as streamResponse): slice consumed lines
      // off once per network chunk instead of re-splitting the whole buffer,
      // which matters here because base64 image payloads are large.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
        const line = buffer.slice(scanStart, newlineIdx);
        scanStart = newlineIdx + 1;
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") continue;
        let chunk: ImageStreamChunk;
        try {
          chunk = JSON.parse(json) as ImageStreamChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          throw streamChunkError(chunk.error);
        }
        const responseData = chunk.response || chunk;
        for (const candidate of responseData.candidates || []) {
          collectImagesFromParts(candidate.content?.parts, images, text);
        }
      }
      if (scanStart > 0) {
        buffer = buffer.slice(scanStart);
        scanStart = 0;
      }
      if (result.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return { images, text };
}

function fsErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function imageDirectorySegments(
  cwd: string,
  filePath: string,
): Promise<{ root: string; segments: string[] }> {
  const lexicalRoot = resolve(cwd);
  const targetDir = dirname(filePath);
  const relDir = relative(lexicalRoot, targetDir);
  if (relDir === ".." || relDir.startsWith(`..${sep}`) || isAbsolute(relDir)) {
    throw new Error("Image save path must be inside the working directory.");
  }
  const root = await realpath(lexicalRoot);
  return { root, segments: relDir ? relDir.split(sep).filter(Boolean) : [] };
}

async function assertSafeImageSaveDestination(cwd: string, filePath: string): Promise<void> {
  const { root, segments } = await imageDirectorySegments(cwd, filePath);
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink()) {
        throw new Error("Image save path escapes the working directory (symlink traversal).");
      }
      if (!info.isDirectory()) {
        throw new Error("Image save path contains a non-directory ancestor.");
      }
      current = next;
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function ensureSafeImageDirectory(cwd: string, filePath: string): Promise<string> {
  const { root, segments } = await imageDirectorySegments(cwd, filePath);
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (fsErrorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if (fsErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      info = await lstat(next);
    }
    if (info.isSymbolicLink()) {
      throw new Error("Image save path escapes the working directory (symlink traversal).");
    }
    if (!info.isDirectory()) {
      throw new Error("Image save path contains a non-directory ancestor.");
    }
    current = next;
  }
  return current;
}

const PROC_FD_ROOT = "/proc/self/fd";

function procFdPath(handle: FileHandle, child?: string): string {
  const base = join(PROC_FD_ROOT, String(handle.fd));
  return child ? join(base, child) : base;
}

async function openNoFollowDirectory(path: string): Promise<FileHandle> {
  return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
}

/**
 * Linux hardening path: traverse/create every directory relative to an already
 * opened directory descriptor exposed through /proc/self/fd. Once a parent is
 * open, renaming/replacing its pathname cannot redirect later child resolution.
 *
 * Node/Bun do not expose openat(2) directly. /proc/self/fd provides equivalent
 * anchoring on Linux; non-Linux hosts fall back to the path-based no-follow
 * checks below.
 */
async function openAnchoredImageDirectory(
  cwd: string,
  filePath: string,
): Promise<FileHandle | undefined> {
  if (process.platform !== "linux") return undefined;

  const { root, segments } = await imageDirectorySegments(cwd, filePath);
  let current = await openNoFollowDirectory(root);
  try {
    // Some restricted Linux containers do not mount procfs. Detect that before
    // relying on the descriptor path and use the portable fallback instead.
    try {
      await lstat(procFdPath(current));
    } catch {
      await current.close();
      return undefined;
    }

    for (const segment of segments) {
      const childPath = procFdPath(current, segment);
      let next: FileHandle;
      try {
        next = await openNoFollowDirectory(childPath);
      } catch (error) {
        if (fsErrorCode(error) !== "ENOENT") throw error;
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (mkdirError) {
          if (fsErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
        }
        next = await openNoFollowDirectory(childPath);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function writeImage(cwd: string, filePath: string, image: GeneratedImage): Promise<string> {
  const data = Buffer.from(image.data, "base64");
  const anchoredDir = await openAnchoredImageDirectory(cwd, filePath);
  if (anchoredDir) {
    try {
      await writePrivateFileNoFollow(procFdPath(anchoredDir, basename(filePath)), data);
      return filePath;
    } finally {
      await anchoredDir.close();
    }
  }

  const realDir = await ensureSafeImageDirectory(cwd, filePath);
  const realTarget = join(realDir, basename(filePath));
  await writePrivateFileNoFollow(realTarget, data);
  return filePath;
}

export async function generateAntigravityImage(
  options: GenerateImageOptions,
): Promise<GenerateImageResult> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("Image prompt is required.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Image prompt is too long (max ${MAX_PROMPT_CHARS} characters).`);
  }
  const aspectRatio = assertSafeAspectRatio(options.aspectRatio || "1:1");
  const preferred = assertSafeImageModel(options.model || DEFAULT_IMAGE_MODEL);
  // Path containment is independent of the generated MIME type. Reject invalid
  // user input and existing symlink ancestors before spending generation quota.
  const preflightPath = resolveImageSavePath(options.cwd, options.path);
  await assertSafeImageSaveDestination(options.cwd, preflightPath);
  const models = [preferred, ...IMAGE_MODEL_FALLBACKS.filter((id) => id !== preferred)];
  const creds = parseApiKey(options.apiKey);
  // Bare-token or legacy placeholder credentials carry no authoritative
  // project id — discover it the same way the streaming path does.
  const credentialProjectId =
    creds.projectId && !isPlaceholderProjectId(creds.projectId) ? creds.projectId : undefined;
  const projectId =
    credentialProjectId || (await loadCodeAssist(creds.token)) || defaultProjectId();
  const headers = antigravityHeaders(creds.token);
  const endpoints = endpointCandidates();

  let lastError = "no endpoint available";
  for (const model of models) {
    const body = JSON.stringify(buildImageGenerateRequest(prompt, model, projectId, aspectRatio));
    for (const endpoint of endpoints) {
      if (options.signal?.aborted) throw new Error("Request was aborted");
      try {
        // One deadline per attempt: each endpoint/model candidate gets its own
        // budget rather than sharing a single exhausted one.
        const signal = withDeadline(IMAGE_REQUEST_TIMEOUT_MS, options.signal);
        const response = await antigravityFetch(
          `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers,
            body,
            signal,
          },
        );
        if (!response.ok) {
          lastError = jsonOrTextError(await response.text()).slice(0, 400);
          if (isRetryableEndpointStatus(response.status)) {
            continue;
          }
          // Account-level failures (401/403/429, invalid request) can never succeed
          // on another endpoint or image model — abort the fan-out entirely.
          throw new AntigravityHttpError(safeError(lastError), response.status, endpoint);
        }
        const parsed = await collectImagesFromSse(response, signal);
        if (!parsed.images.length) {
          lastError = parsed.text.join(" ").trim() || "No image data returned.";
          continue;
        }
        recordSuccessfulEndpoint(endpoint);
        const savedPaths: string[] = [];
        const many = parsed.images.length > 1;
        try {
          for (const [index, image] of parsed.images.entries()) {
            savedPaths.push(
              await writeImage(
                options.cwd,
                resolveImageSavePath(
                  options.cwd,
                  options.path,
                  image.mimeType,
                  many ? index : undefined,
                ),
                image,
              ),
            );
          }
        } catch (error) {
          throw new ImageSaveError(error);
        }
        return { images: parsed.images, savedPaths, text: parsed.text, model };
      } catch (error) {
        if (error instanceof ImageSaveError) throw error;
        if (options.signal?.aborted) {
          throw new Error("Request was aborted", { cause: error });
        }
        // Account-level failures (401/403/429, bad request) can never succeed on
        // another endpoint or image model — abort the fan-out entirely.
        const status =
          error instanceof AntigravityHttpError || error instanceof ProviderHttpError
            ? error.status
            : undefined;
        if (status !== undefined && !isRetryableEndpointStatus(status)) {
          throw error;
        }
        lastError = safeError(error);
      }
    }
  }
  throw new Error(`Antigravity image generation failed: ${safeError(lastError)}`);
}
