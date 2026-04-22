/**
 * Swagger 2.0 → OpenAPI 3.0.3 converter.
 *
 * Converts a Swagger 2.0 document object into an OpenAPI 3.0.3 document object.
 * Handles security definitions, schema $ref rewrites, body parameter → requestBody
 * promotion, and response schema → content wrapping.
 *
 * The input object is NOT mutated — all transformations produce new objects.
 */

// ─── Public API ─────────────────────────────────────────────────────────────

export interface OpenApi3Document {
  readonly openapi: "3.0.3";
  readonly info: { title: string; description: string; version: string };
  readonly servers: ReadonlyArray<{ url: string; description: string }>;
  readonly security: unknown[];
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

/**
 * Convert a parsed Swagger 2.0 object to an OpenAPI 3.0.3 object.
 * The input is deep-cloned internally so the caller's object is never mutated.
 */
export function convertSwagger20ToOpenApi30(swagger: Record<string, unknown>): OpenApi3Document {
  // Deep-clone to avoid mutating the caller's object
  const src: Record<string, unknown> = JSON.parse(JSON.stringify(swagger));

  const info = src["info"] as { title: string; description: string; version: string };
  const host = (src["host"] as string) ?? "graph.microsoft.com";
  const basePath = (src["basePath"] as string) ?? "";
  const schemes = (src["schemes"] as string[]) ?? ["https"];

  const openapi: OpenApi3Document = {
    openapi: "3.0.3",
    info: { ...info },
    servers: [
      {
        url: `${schemes[0] ?? "https"}://${host}${basePath}`,
        description: "Microsoft Graph API",
      },
    ],
    security: (src["security"] as unknown[]) ?? [],
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {},
    },
  };

  // Convert securityDefinitions → components.securitySchemes
  convertSecurityDefinitions(src, openapi);

  // Convert definitions → components.schemas
  convertDefinitions(src, openapi);

  // Convert paths — body params → requestBody, fix $ref paths, wrap response schemas
  convertPaths(src, openapi);

  return openapi;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function convertSecurityDefinitions(
  src: Record<string, unknown>,
  target: OpenApi3Document
): void {
  const secDefs = src["securityDefinitions"] as Record<string, Record<string, unknown>> | undefined;
  if (!secDefs) return;

  for (const [name, def] of Object.entries(secDefs)) {
    if (def["type"] === "oauth2") {
      const scheme: Record<string, unknown> = {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: def["authorizationUrl"],
            tokenUrl: def["tokenUrl"],
            scopes: (def["scopes"] as Record<string, string>) ?? {},
          },
        },
      };
      // Preserve x-ms-* extensions
      for (const [k, v] of Object.entries(def)) {
        if (k.startsWith("x-")) {
          scheme[k] = v;
        }
      }
      target.components.securitySchemes[name] = scheme;
    } else {
      target.components.securitySchemes[name] = { ...def };
    }
  }
}

function convertDefinitions(
  src: Record<string, unknown>,
  target: OpenApi3Document
): void {
  const defs = src["definitions"] as Record<string, unknown> | undefined;
  if (!defs) return;

  for (const [name, schema] of Object.entries(defs)) {
    target.components.schemas[name] = rewriteSchemaRefs(schema);
  }
}

function convertPaths(
  src: Record<string, unknown>,
  target: OpenApi3Document
): void {
  const paths = src["paths"] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return;

  for (const [pathKey, methods] of Object.entries(paths)) {
    target.paths[pathKey] = {};

    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation !== "object" || operation === null) continue;
      const op = { ...(operation as Record<string, unknown>) };

      const newParams: unknown[] = [];
      let requestBody: unknown = null;

      if (Array.isArray(op["parameters"])) {
        for (const param of op["parameters"] as Record<string, unknown>[]) {
          if (param["in"] === "body") {
            requestBody = {
              required: param["required"] ?? true,
              description: param["description"] ?? "",
              content: {
                "application/json": {
                  schema: rewriteSchemaRefs(param["schema"] ?? { type: "object" }),
                },
              },
            };
          } else {
            const converted: Record<string, unknown> = { ...param };
            const paramType = (converted["type"] as string) ?? "string";
            delete converted["type"];

            const schema: Record<string, unknown> = { type: paramType };
            if (converted["format"]) {
              schema["format"] = converted["format"];
              delete converted["format"];
            }
            if (converted["items"]) {
              schema["items"] = converted["items"];
              delete converted["items"];
            }
            if (converted["enum"]) {
              schema["enum"] = converted["enum"];
              delete converted["enum"];
            }

            converted["schema"] = schema;
            newParams.push(converted);
          }
        }
      }

      op["parameters"] = newParams.length > 0 ? newParams : undefined;
      if (requestBody) {
        op["requestBody"] = requestBody;
      }

      // Convert response schemas → content wrappers
      const responses = op["responses"] as Record<string, Record<string, unknown>> | undefined;
      if (responses) {
        const newResponses: Record<string, unknown> = {};
        for (const [statusCode, resp] of Object.entries(responses)) {
          const newResp = { ...resp };
          if (newResp["schema"]) {
            const convertedSchema = rewriteSchemaRefs(newResp["schema"]);
            newResp["content"] = {
              "application/json": { schema: convertedSchema },
            };
            delete newResp["schema"];
          }
          newResponses[statusCode] = newResp;
        }
        op["responses"] = newResponses;
      }

      target.paths[pathKey]![method] = op;
    }
  }
}

/**
 * Recursively rewrite `#/definitions/Foo` → `#/components/schemas/Foo` in schema $refs.
 */
function rewriteSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;

  const obj = schema as Record<string, unknown>;

  if (typeof obj["$ref"] === "string") {
    return {
      ...obj,
      $ref: (obj["$ref"] as string).replace("#/definitions/", "#/components/schemas/"),
    };
  }

  const result: Record<string, unknown> = { ...obj };

  if (result["properties"] && typeof result["properties"] === "object") {
    const newProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result["properties"] as Record<string, unknown>)) {
      newProps[k] = rewriteSchemaRefs(v);
    }
    result["properties"] = newProps;
  }
  if (result["items"]) {
    result["items"] = rewriteSchemaRefs(result["items"]);
  }
  if (result["additionalProperties"] && typeof result["additionalProperties"] === "object") {
    result["additionalProperties"] = rewriteSchemaRefs(result["additionalProperties"]);
  }
  if (Array.isArray(result["allOf"])) {
    result["allOf"] = (result["allOf"] as unknown[]).map(rewriteSchemaRefs);
  }
  if (Array.isArray(result["oneOf"])) {
    result["oneOf"] = (result["oneOf"] as unknown[]).map(rewriteSchemaRefs);
  }
  if (Array.isArray(result["anyOf"])) {
    result["anyOf"] = (result["anyOf"] as unknown[]).map(rewriteSchemaRefs);
  }

  return result;
}
