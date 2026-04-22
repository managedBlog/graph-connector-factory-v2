/**
 * Schema normalizer for Power Platform compatibility.
 *
 * Transforms OpenAPI 3.0 / OData-derived schemas into Swagger 2.0–safe structures:
 * - Flattens allOf/oneOf/anyOf into merged plain objects.
 * - Collapses OData inheritance chains.
 * - Strips discriminators and unsupported keywords.
 * - Converts OpenAPI 3.0 constructs to Swagger 2.0 equivalents.
 *
 * All functions are pure — no I/O.
 */

export interface NormalizationResult {
  readonly schema: Record<string, unknown>;
  readonly log: string[];
}

export interface SwaggerDefinitions {
  [definitionName: string]: Record<string, unknown>;
}

// ─── allOf flattening ───────────────────────────────────────────────────────

function flattenAllOf(schema: Record<string, unknown>, logEntries: string[], path: string): Record<string, unknown> {
  const allOf = schema["allOf"] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(allOf) || allOf.length === 0) return schema;

  logEntries.push(`Flattened allOf at ${path} (${allOf.length} schemas merged).`);

  const mergedProperties: Record<string, unknown> = {};
  const mergedRequired: string[] = [];
  let mergedDescription = schema["description"] as string | undefined;

  for (const sub of allOf) {
    const normalized = normalizeSchemaRecursive(sub, logEntries, path);
    const props = normalized["properties"] as Record<string, unknown> | undefined;
    if (props) {
      Object.assign(mergedProperties, props);
    }
    const req = normalized["required"] as string[] | undefined;
    if (Array.isArray(req)) {
      mergedRequired.push(...req);
    }
    if (!mergedDescription && normalized["description"]) {
      mergedDescription = String(normalized["description"]);
    }
  }

  // Also merge properties from the parent schema itself
  const parentProps = schema["properties"] as Record<string, unknown> | undefined;
  if (parentProps) {
    Object.assign(mergedProperties, parentProps);
  }
  const parentReq = schema["required"] as string[] | undefined;
  if (Array.isArray(parentReq)) {
    mergedRequired.push(...parentReq);
  }

  const result: Record<string, unknown> = {
    type: "object",
    properties: mergedProperties,
  };

  if (mergedRequired.length > 0) {
    result["required"] = [...new Set(mergedRequired)];
  }
  if (mergedDescription) {
    result["description"] = mergedDescription;
  }

  return result;
}

// ─── oneOf / anyOf flattening ───────────────────────────────────────────────

function flattenOneOfAnyOf(schema: Record<string, unknown>, logEntries: string[], path: string): Record<string, unknown> {
  const variants = (schema["oneOf"] ?? schema["anyOf"]) as Record<string, unknown>[] | undefined;
  const keyword = schema["oneOf"] ? "oneOf" : "anyOf";

  if (!Array.isArray(variants) || variants.length === 0) return schema;

  logEntries.push(`Flattened ${keyword} at ${path} (${variants.length} variants merged into union object). Type discrimination lost.`);

  // Merge all variant properties into a single object (union of all fields)
  const mergedProperties: Record<string, unknown> = {};

  for (const variant of variants) {
    const normalized = normalizeSchemaRecursive(variant, logEntries, `${path}.${keyword}`);
    const props = normalized["properties"] as Record<string, unknown> | undefined;
    if (props) {
      Object.assign(mergedProperties, props);
    }
  }

  const result: Record<string, unknown> = {
    type: "object",
    properties: mergedProperties,
  };

  if (schema["description"]) {
    result["description"] = schema["description"];
  }

  return result;
}

// ─── Swagger 2.0 keyword cleanup ───────────────────────────────────────────

function cleanSwagger2Keywords(schema: Record<string, unknown>, logEntries: string[], path: string): Record<string, unknown> {
  const result = { ...schema };

  // Remove nullable (not supported in Swagger 2.0)
  if ("nullable" in result) {
    delete result["nullable"];
    logEntries.push(`Removed 'nullable' at ${path} (not supported in Swagger 2.0).`);
  }

  // Remove discriminator object (Swagger 2.0 uses simple string discriminator)
  if (typeof result["discriminator"] === "object") {
    delete result["discriminator"];
    logEntries.push(`Removed complex discriminator at ${path}.`);
  }

  // Convert readOnly at property level (keep as-is, Swagger 2.0 supports it)

  // Remove OpenAPI 3.0-only keywords
  const unsupported = ["writeOnly", "deprecated", "xml", "externalDocs"];
  for (const kw of unsupported) {
    if (kw in result) {
      delete result[kw];
      logEntries.push(`Removed unsupported keyword '${kw}' at ${path}.`);
    }
  }

  return result;
}

// ─── Recursive normalizer ───────────────────────────────────────────────────

function normalizeSchemaRecursive(
  schema: Record<string, unknown>,
  logEntries: string[],
  path: string
): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return schema;

  let result = { ...schema };

  // Handle allOf first
  if (result["allOf"]) {
    result = flattenAllOf(result, logEntries, path);
  }

  // Handle oneOf/anyOf
  if (result["oneOf"] || result["anyOf"]) {
    result = flattenOneOfAnyOf(result, logEntries, path);
  }

  // Clean Swagger 2.0 keywords
  result = cleanSwagger2Keywords(result, logEntries, path);

  // Recurse into properties
  const properties = result["properties"] as Record<string, Record<string, unknown>> | undefined;
  if (properties && typeof properties === "object") {
    const normalizedProps: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(properties)) {
      if (typeof propSchema === "object" && propSchema !== null) {
        normalizedProps[propName] = normalizeSchemaRecursive(
          propSchema,
          logEntries,
          `${path}.properties.${propName}`
        );
      } else {
        normalizedProps[propName] = propSchema;
      }
    }
    result["properties"] = normalizedProps;
  }

  // Recurse into items (arrays)
  const items = result["items"] as Record<string, unknown> | undefined;
  if (items && typeof items === "object") {
    result["items"] = normalizeSchemaRecursive(items, logEntries, `${path}.items`);
  }

  // Recurse into additionalProperties
  const addlProps = result["additionalProperties"] as Record<string, unknown> | undefined;
  if (addlProps && typeof addlProps === "object") {
    result["additionalProperties"] = normalizeSchemaRecursive(addlProps, logEntries, `${path}.additionalProperties`);
  }

  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Normalize a single schema definition for Power Platform / Swagger 2.0 compatibility.
 */
export function normalizeSchema(
  schema: Record<string, unknown>,
  path: string = "#"
): NormalizationResult {
  const log: string[] = [];
  const normalized = normalizeSchemaRecursive(schema, log, path);
  return { schema: normalized, log };
}

/**
 * Normalize all definitions in a Swagger definitions block.
 */
export function normalizeDefinitions(
  definitions: SwaggerDefinitions
): { definitions: SwaggerDefinitions; log: string[] } {
  const allLog: string[] = [];
  const normalizedDefs: SwaggerDefinitions = {};

  for (const [name, schema] of Object.entries(definitions)) {
    const { schema: normalized, log } = normalizeSchema(schema, `#/definitions/${name}`);
    normalizedDefs[name] = normalized;
    allLog.push(...log);
  }

  return { definitions: normalizedDefs, log: allLog };
}

/**
 * Build a Swagger 2.0 schema definition for a Graph entity type,
 * given the entity's properties and navigation properties from CSDL.
 */
export function buildEntitySchema(
  entityName: string,
  properties: Array<{ name: string; type: string; nullable: boolean; description?: string }>,
  navigationProperties: Array<{ name: string; type: string; isCollection: boolean }>
): Record<string, unknown> {
  const schemaProps: Record<string, Record<string, unknown>> = {};

  for (const prop of properties) {
    const propSchema: Record<string, unknown> = {
      type: toSwaggerPrimitiveType(prop.type),
      description: prop.description ?? prop.name,
      "x-ms-summary": formatSummary(prop.name),
    };

    // Mark ID fields as internal visibility
    if (prop.name.toLowerCase() === "id" || prop.name.toLowerCase().endsWith("id")) {
      propSchema["x-ms-visibility"] = "internal";
    }

    schemaProps[prop.name] = propSchema;
  }

  for (const nav of navigationProperties) {
    if (nav.isCollection) {
      schemaProps[nav.name] = {
        type: "array",
        items: { type: "object" },
        description: `Navigation property: ${nav.name}`,
        "x-ms-summary": formatSummary(nav.name),
        "x-ms-visibility": "advanced",
      };
    } else {
      schemaProps[nav.name] = {
        type: "object",
        description: `Navigation property: ${nav.name}`,
        "x-ms-summary": formatSummary(nav.name),
        "x-ms-visibility": "advanced",
      };
    }
  }

  return {
    type: "object",
    properties: schemaProps,
  };
}

function toSwaggerPrimitiveType(edmType: string): string {
  const base = edmType.replace("Edm.", "").replace("Collection(", "").replace(")", "");
  const typeMap: Record<string, string> = {
    String: "string",
    Int32: "integer",
    Int64: "integer",
    Boolean: "boolean",
    DateTimeOffset: "string",
    Guid: "string",
    Binary: "string",
    Stream: "string",
    Double: "number",
    Single: "number",
    Decimal: "number",
    Int16: "integer",
    Byte: "integer",
    Duration: "string",
    Date: "string",
    TimeOfDay: "string",
  };
  return typeMap[base] ?? "string";
}

function formatSummary(name: string): string {
  // Convert camelCase/PascalCase to Title Case
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}
