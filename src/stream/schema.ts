import type { Tool } from "@oh-my-pi/pi-ai";
import { setLastToolSchemaWarnings } from "../diagnostics/diagnostics.js";
import type { GeminiFunctionDeclaration } from "../types/types.js";
import { isRecord } from "../utils/util.js";

type SchemaReferenceIssue = {
  path: string;
  ref: string;
  reason: string;
};

type DereferencedSchema = {
  schema: unknown;
  issues: SchemaReferenceIssue[];
};

type DereferenceState = {
  nodes: number;
};

const MAX_SCHEMA_DEREFERENCE_DEPTH = 64;
const MAX_SCHEMA_DEREFERENCE_NODES = 10_000;
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Resolve a local RFC 6901 JSON Pointer against the original tool schema. */
function resolveLocalJsonPointer(ref: string, rootSchema: unknown): unknown {
  if (ref === "#") return rootSchema;
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = rootSchema;
  for (const token of ref.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Dereference every schema in a keyword map without interpreting map keys as JSON Schema keywords. */
function dereferenceSchemaMap(
  schemaMap: unknown,
  rootSchema: unknown,
  refStack: Set<string>,
  objectStack: Set<object>,
  state: DereferenceState,
  path: string,
  depth: number,
): DereferencedSchema {
  if (!isRecord(schemaMap)) {
    return dereferenceSchema(schemaMap, rootSchema, refStack, objectStack, state, path, depth);
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(schemaMap)) {
    const result = dereferenceSchema(
      value,
      rootSchema,
      refStack,
      objectStack,
      state,
      `${path}.${key}`,
      depth,
    );
    out[key] = result.schema;
    issues.push(...result.issues);
  }
  return { schema: out, issues };
}

/**
 * Inline reachable local references while bounding expansion of untrusted MCP schemas.
 * A reported issue causes only the affected tool declaration to be omitted.
 */
function dereferenceSchema(
  schema: unknown,
  rootSchema: unknown = schema,
  refStack = new Set<string>(),
  objectStack = new Set<object>(),
  state: DereferenceState = { nodes: 0 },
  path = "$",
  depth = 0,
): DereferencedSchema {
  if (depth > MAX_SCHEMA_DEREFERENCE_DEPTH) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(depth limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_DEPTH} levels`,
        },
      ],
    };
  }
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_DEREFERENCE_NODES) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(node limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_NODES} nodes`,
        },
      ],
    };
  }
  if (!schema || typeof schema !== "object") return { schema, issues: [] };

  if (Array.isArray(schema)) {
    const results = schema.map((item, index) =>
      dereferenceSchema(
        item,
        rootSchema,
        refStack,
        objectStack,
        state,
        `${path}[${index}]`,
        depth + 1,
      ),
    );
    return {
      schema: results.map((result) => result.schema),
      issues: results.flatMap((result) => result.issues),
    };
  }

  const s = schema as Record<string, unknown>;
  if (objectStack.has(s)) {
    return {
      schema: {},
      issues: [{ path, ref: "(object cycle)", reason: "circular schema object" }],
    };
  }

  const nextObjectStack = new Set(objectStack);
  nextObjectStack.add(s);

  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (refStack.has(ref)) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "circular local reference" }],
      };
    }

    const target = resolveLocalJsonPointer(ref, rootSchema);
    if (target === undefined) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "target is not present in the root schema" }],
      };
    }

    const nextRefStack = new Set(refStack);
    nextRefStack.add(ref);
    const resolved = dereferenceSchema(
      target,
      rootSchema,
      nextRefStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );
    const { $ref: _, ...siblings } = s;
    const siblingResult = dereferenceSchema(
      siblings,
      rootSchema,
      refStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );

    if (isRecord(resolved.schema) && isRecord(siblingResult.schema)) {
      return {
        schema: { ...resolved.schema, ...siblingResult.schema },
        issues: [...resolved.issues, ...siblingResult.issues],
      };
    }
    return {
      schema: resolved.schema,
      issues: [...resolved.issues, ...siblingResult.issues],
    };
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(s)) {
    // Definitions are available through rootSchema while resolving $ref, but must
    // not be emitted because the Antigravity backend requires self-contained schemas.
    if (key === "$defs" || key === "definitions") continue;

    let result: DereferencedSchema | undefined;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      result = dereferenceSchemaMap(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      result = dereferenceSchema(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    }

    if (result) {
      out[key] = result.schema;
      issues.push(...result.issues);
    } else {
      out[key] = value;
    }
  }
  return { schema: out, issues };
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

const META_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

/** Remove schema metadata without treating user-defined property names as keywords. */
function stripMetaSchemaMap(schemaMap: unknown): unknown {
  if (!isRecord(schemaMap)) return stripMetaSchema(schemaMap);
  return Object.fromEntries(
    Object.entries(schemaMap).map(([key, value]) => [key, stripMetaSchema(value)]),
  );
}

/** Remove metadata that Cloud Code Assist rejects from JSON Schema keyword positions. */
function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripMetaSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_SCHEMA_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = stripMetaSchemaMap(value);
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      out[key] = stripMetaSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Protobuf `Schema` fields accepted by Cloud Code Assist's Claude/GPT custom-tool
 * bridge (`parameters` field). Anything else — `nullable`, `anyOf`, `format`,
 * `$ref`, etc. — returns `Unknown name "..."` / Invalid JSON payload (400).
 * Allowlist rather than denylist so new JSON Schema keywords cannot 400 the request.
 * OMP still validates tool args after the model calls them.
 */
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  // JSON Schema union types like ["string","null"] → first non-null scalar type.
  const entries = value as unknown[];
  const scalar = entries.find(
    (entry): entry is string => typeof entry === "string" && entry !== "null",
  );
  return scalar;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      // Property names are user-defined, not Schema keywords — never allowlist-filter them.
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (
      key === "enum" &&
      Array.isArray(value) &&
      !value.every((entry) => typeof entry === "string")
    ) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

/**
 * Gemini accepts JSON Schema through parametersJsonSchema. Claude and GPT-OSS
 * use Cloud Code Assist's custom-tool bridge, which requires a compatible
 * Draft 2020-12 subset in the legacy parameters field.
 */
export function convertTools(
  tools: Tool[] | undefined,
  useLegacyParameters = false,
): { functionDeclarations: GeminiFunctionDeclaration[] }[] | undefined {
  if (!tools?.length) return undefined;

  const warnings: string[] = [];
  const functionDeclarations = tools.flatMap((tool) => {
    const dereferenced = dereferenceSchema(tool.parameters);
    if (dereferenced.issues.length > 0) {
      const detail = dereferenced.issues
        .map((issue) => `${issue.path} (${issue.ref}: ${issue.reason})`)
        .join(", ");
      warnings.push(`Skipped tool '${tool.name}' due to unresolved schema reference: ${detail}`);
      return [];
    }

    const rootObject = ensureRootObjectSchema(dereferenced.schema);
    const schema = stripMetaSchema(rootObject);
    return [
      {
        name: tool.name,
        description: tool.description,
        ...(useLegacyParameters
          ? { parameters: normalizeCustomToolSchema(schema) }
          : { parametersJsonSchema: schema }),
      },
    ];
  });

  setLastToolSchemaWarnings(warnings.length ? warnings : undefined);
  if (!functionDeclarations.length) return undefined;
  return [{ functionDeclarations }];
}
