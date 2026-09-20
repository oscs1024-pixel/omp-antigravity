import type { Server } from "node:http";
import type {
  OAuthCredentials,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@oh-my-pi/pi-ai";
import type {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
  ThinkingEffort,
} from "./enums.js";

// OAuth & Auth Types
export type AntigravityOAuthCredentials = OAuthCredentials & {
  projectId?: string;
  email?: string;
};

export type AntigravityApiKey = {
  token: string;
  projectId: string;
  email?: string;
};

export type DynamicModelInfo = {
  id: string;
  apiProvider?: string;
  modelProvider?: string;
  model?: string;
};

export type CallbackServer = {
  server: Server;
  waitForCode: () => Promise<{ code: string; state: string }>;
  cleanup: () => void;
};

// Model Types
export type AntigravityRouting = {
  off?: string;
  routing?: Partial<Record<ThinkingEffort, string>>;
  defaultRequestId?: string;
};

// Stream & API Types
// The provider's `api` id lives in src/stream/constants.ts (ANTIGRAVITY_API).
// It is deliberately not re-declared here: a second copy once existed with a
// different value ("antigravity-api"), which silently disagreed with the id
// registerProvider hands OMP.

/**
 * OMP hands providers `SimpleStreamOptions` verbatim, so this is a plain alias
 * rather than a narrowed shape. Narrowing `toolChoice` here would make
 * `streamSimple` unassignable to the registered `ProviderConfig.streamSimple`
 * contract, and OMP legitimately sends the object forms of `ToolChoice`
 * (`{type:"function",name}`, `{type:"tool",name}`, `{type:"computer",name}`)
 * when a caller forces one tool.
 */
export type AntigravityStreamOptions = SimpleStreamOptions;

export type GeminiTextPart = { text: string; thoughtSignature?: string };
export type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
export type GeminiThoughtPart = {
  thought: true;
  text: string;
  thoughtSignature?: string;
};
export type GeminiFunctionCallPart = {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  thoughtSignature?: string;
};
export type GeminiFunctionResponsePart = {
  functionResponse: {
    name: string;
    response: { error: string } | { output: string };
    id?: string;
  };
};
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiThoughtPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export type GeminiContent = {
  role: GeminiRole;
  parts: GeminiPart[];
};

export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters?: unknown;
  parametersJsonSchema?: unknown;
};

export type GeminiToolConfig = {
  functionCallingConfig: {
    mode: GeminiToolCallingMode;
    /** Set when the caller forced one specific tool. */
    allowedFunctionNames?: string[];
  };
};

export type ThinkingWire = {
  includeThoughts: boolean;
  thinkingBudget: number;
};

export type GeminiGenerationConfig = {
  temperature?: number;
  maxOutputTokens?: number;
  thinkingConfig?: ThinkingWire;
};

export type GeminiRequestBody = {
  contents: GeminiContent[];
  systemInstruction: {
    role: GeminiRole.User;
    parts: GeminiTextPart[];
  };
  generationConfig?: GeminiGenerationConfig;
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  toolConfig?: GeminiToolConfig;
  sessionId?: string;
  labels?: Record<string, string>;
};

export type AntigravityGenerateRequest = {
  project: string;
  model: string;
  request: GeminiRequestBody;
  requestType: AntigravityRequestType.Agent;
  userAgent: AntigravityUserAgent.Antigravity;
  requestId: string;
};

export type StreamPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
};

export type StreamUsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

export type StreamCandidate = {
  content?: { parts?: StreamPart[] };
  finishReason?: string;
};

export type StreamResponseData = {
  candidates?: StreamCandidate[];
  usageMetadata?: StreamUsageMetadata;
  responseId?: string;
};

export type StreamChunk = StreamResponseData & {
  error?: { message?: string; code?: number; status?: string };
  response?: StreamResponseData;
};

export type LooseImageBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
  mediaType?: string;
  source?: { data?: string; mediaType?: string };
};

export type ContentBlock = TextContent | ThinkingContent | ToolCall | LooseImageBlock;

export type ActiveTextBlock = TextContent;
export type ActiveThinkingBlock = ThinkingContent;
export type ActiveBlock = ActiveTextBlock | ActiveThinkingBlock;

// Usage & Quota Types
export type QuotaBucket = {
  bucketId: string;
  displayName: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction?: number;
};

export type QuotaGroup = {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
};

export type ModelQuotaRow = {
  modelId: string;
  displayName?: string;
  remainingFraction?: number;
  resetTime?: string;
  modelProvider?: string;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  recommended?: boolean;
};

export type TierInfo = {
  id?: string;
  name?: string;
  description?: string;
};

export type AccountUsage = {
  projectId: string;
  endpoint: string;
  email?: string;
  productTier?: TierInfo;
  paidTier?: TierInfo;
  planLabel?: string;
  groups: QuotaGroup[];
  groupDescription?: string;
  /** Set when the (subscription-gated) quota-summary RPC was unavailable, e.g. free-tier SUBSCRIPTION_REQUIRED. */
  quotaSummaryError?: string;
  /** Set when Google returns VALIDATION_REQUIRED with an account verification URL. */
  validationUrl?: string;
  /** Best-effort dynamic model catalog failure; aggregate quota may still be usable. */
  modelCatalogError?: string;
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
  fetchedAt: number;
};

export type ApiErrorBody = {
  error?: { message?: string };
  raw?: string;
};

export type QuotaBucketRaw = {
  bucketId?: unknown;
  displayName?: unknown;
  window?: unknown;
  resetTime?: unknown;
  description?: unknown;
  remainingFraction?: unknown;
};

export type QuotaGroupRaw = {
  displayName?: unknown;
  description?: unknown;
  buckets?: QuotaBucketRaw[];
};

export type QuotaSummaryRaw = {
  description?: unknown;
  groups?: QuotaGroupRaw[];
};

export type ModelInfoRaw = {
  isInternal?: unknown;
  displayName?: unknown;
  label?: unknown;
  modelName?: unknown;
  model?: unknown;
  modelProvider?: unknown;
  apiProvider?: unknown;
  supportsThinking?: unknown;
  supportsImages?: unknown;
  recommended?: unknown;
  /** Backend context-window limit (despite the ambiguous field name). */
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  thinkingBudget?: unknown;
  minThinkingBudget?: unknown;
  quotaInfo?: {
    remainingFraction?: unknown;
    resetTime?: unknown;
  };
};

export type AvailableModelsRaw = {
  models?: Record<string, ModelInfoRaw>;
  defaultAgentModelId?: unknown;
  defaultAgentModel?: unknown;
};

export type TierRaw = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
};

export type LoadCodeAssistRaw = {
  currentTier?: TierRaw;
  paidTier?: TierRaw;
};
