export const ANTIGRAVITY_API = "antigravity";

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";

export const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';

export const CONTINUATION_TEXT =
  "Continue the active task using the available instructions and context.";

export const FORCED_TOOL_DIRECTIVE =
  "TOOL-ONLY TURN. This turn accepts a tool call and nothing else; a text reply here is discarded unread and you will be re-prompted. Emit the tool call now.";

export const STREAM_HEADER_TIMEOUT_DEFAULT_MS = 180_000;
export const STREAM_STALL_TIMEOUT_DEFAULT_MS = 120_000;
