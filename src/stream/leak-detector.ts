export function isPlanningLeakPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  const afterBrace = trimmed.slice(1).trimStart();
  if (afterBrace === "") return trimmed.length <= 100;
  if (afterBrace[0] !== '"') return false;
  const nextQuoteIndex = afterBrace.indexOf('"', 1);
  if (nextQuoteIndex === -1) {
    const keyPrefix = afterBrace.slice(1);
    return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
  }
  const key = afterBrace.slice(1, nextQuoteIndex);
  if (key !== "thought") return false;
  const afterKey = afterBrace.slice(nextQuoteIndex + 1).trimStart();
  if (afterKey === "") return trimmed.length <= 100;
  return afterKey[0] === ":";
}

export function isPlanningLeakObject(parsed: unknown, toolNames: Set<string>): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  const hasThought = typeof record.thought === "string";
  const isOmpTool = typeof record.call === "string" && toolNames.has(record.call);
  const hasToolSignature =
    "_i" in record ||
    "paths" in record ||
    "command" in record ||
    ("path" in record && "content" in record);
  return hasThought || isOmpTool || hasToolSignature;
}

export function splitLeadingJsonObject(
  text: string,
): { prefixLength: number; jsonText: string; rest: string } | undefined {
  const prefixLength = text.length - text.trimStart().length;
  const trimmed = text.slice(prefixLength);
  if (!trimmed.startsWith("{")) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          prefixLength: prefixLength + index + 1,
          jsonText: trimmed.slice(0, index + 1),
          rest: trimmed.slice(index + 1),
        };
      }
    }
  }
  return undefined;
}
