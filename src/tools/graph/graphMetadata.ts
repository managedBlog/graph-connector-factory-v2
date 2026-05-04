/**
 * Graph CSDL metadata provider.
 * Fetches OData CSDL XML from graph.microsoft.com/$metadata,
 * caches locally, and parses into GraphOperationInfo[].
 *
 * Prefers `hidi` CLI for conversion when available; falls back to pure-TS XML parsing.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { execFile } from "child_process";
import { XMLParser } from "fast-xml-parser";
import { log, logWarn, logDebug } from "../../logging/logger";
import { GraphOperationInfo, GraphOperationParameter, RequestBodyProperty } from "./types";

// ─── CSDL fetch + cache ────────────────────────────────────────────────────

function getCacheFilePath(cachePath: string, version: string): string {
  return path.resolve(cachePath, `csdl-${version}.xml`);
}

function isCacheValid(cacheFile: string, ttlHours: number): boolean {
  if (!fs.existsSync(cacheFile)) return false;
  const stat = fs.statSync(cacheFile);
  const ageMs = Date.now() - stat.mtimeMs;
  const ttlMs = ttlHours * 60 * 60 * 1000;
  return ageMs < ttlMs;
}

function getCacheAge(cacheFile: string): string {
  if (!fs.existsSync(cacheFile)) return "no cache";
  const stat = fs.statSync(cacheFile);
  const ageMs = Date.now() - stat.mtimeMs;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${minutes}m`;
}

function fetchCsdl(version: string): Promise<string> {
  const url = `https://graph.microsoft.com/${version}/$metadata`;
  log(`Fetching CSDL from ${url}…`);

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`CSDL fetch failed with status ${res.statusCode ?? "unknown"}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export async function loadCsdl(
  version: string,
  cachePath: string,
  ttlHours: number,
  forceRefresh: boolean
): Promise<{ xml: string; cacheAge: string }> {
  const cacheDir = path.resolve(cachePath);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const cacheFile = getCacheFilePath(cacheDir, version);

  if (!forceRefresh && isCacheValid(cacheFile, ttlHours)) {
    logDebug(`Using cached CSDL: ${cacheFile}`);
    const xml = fs.readFileSync(cacheFile, "utf-8");
    return { xml, cacheAge: getCacheAge(cacheFile) };
  }

  const xml = await fetchCsdl(version);
  fs.writeFileSync(cacheFile, xml, "utf-8");
  log(`CSDL cached to ${cacheFile}`);
  return { xml, cacheAge: "just fetched" };
}

// ─── hidi CLI detection ────────────────────────────────────────────────────

function detectHidi(configPath: string | null): string | null {
  if (configPath) {
    if (fs.existsSync(configPath)) return configPath;
    logWarn(`Configured hidi path not found: ${configPath}`);
    return null;
  }

  // Probe common executable names directly. This avoids noisy platform-specific
  // locator output (e.g., Windows where.exe "Could not find files..." lines).
  const candidates = ["hidi", "hidi.exe"];
  for (const name of candidates) {
    try {
      require("child_process").execFileSync(name, ["--help"], {
        stdio: "ignore",
        timeout: 5000,
      });
      logDebug(`Found hidi on PATH as: ${name}`);
      return name;
    } catch {
      // not found, continue
    }
  }

  logDebug("hidi CLI not found on PATH; will use pure-TS fallback.");
  return null;
}

export async function convertCsdlWithHidi(
  csdlUrl: string,
  entityFilter: string,
  hidiPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "transform",
      "--csdl", csdlUrl,
      "--csdl-filter", entityFilter,
      "-f", "json",
      "-v", "2.0",
      "--output", "-",
    ];

    execFile(hidiPath, args, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        logWarn(`hidi conversion failed: ${stderr || err.message}`);
        reject(new Error(`hidi conversion failed: ${err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// ─── Pure-TS CSDL XML parsing ──────────────────────────────────────────────

interface CsdlEntityProperty {
  "@_Name": string;
  "@_Type": string;
  "@_Nullable"?: string;
}

interface CsdlNavigationProperty {
  "@_Name": string;
  "@_Type": string;
  "@_ContainsTarget"?: string;
}

interface CsdlEntityType {
  "@_Name": string;
  "@_BaseType"?: string;
  "Property"?: CsdlEntityProperty | CsdlEntityProperty[];
  "NavigationProperty"?: CsdlNavigationProperty | CsdlNavigationProperty[];
}

interface CsdlEntitySet {
  "@_Name": string;
  "@_EntityType": string;
}

interface CsdlSingleton {
  "@_Name": string;
  "@_Type": string;
}

interface CsdlActionParameter {
  "@_Name": string;
  "@_Type": string;
  "@_Nullable"?: string;
}

interface CsdlAction {
  "@_Name": string;
  "@_IsBound"?: string;
  "Parameter"?: CsdlActionParameter | CsdlActionParameter[];
}

interface CsdlEnumMember {
  "@_Name": string;
  "@_Value"?: string;
}

interface CsdlEnumType {
  "@_Name": string;
  "Member"?: CsdlEnumMember | CsdlEnumMember[];
}

function ensureArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

function toSwaggerType(edmType: string): string {
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

const MAX_COMPLEX_DEPTH = 3;

/**
 * Resolve a CSDL property type into a RequestBodyProperty (without name/description).
 * Handles primitives, enums, and complex types with recursive resolution.
 * When enrichComplexTypes is false, complex types fall back to "string" (legacy behavior).
 */
function resolvePropertySchema(
  edmType: string,
  complexTypes: Map<string, CsdlEntityType>,
  enumTypes: Map<string, string[]>,
  enrichComplexTypes: boolean,
  ancestors: Set<string> = new Set(),
  depth: number = 0
): Partial<RequestBodyProperty> {
  const isCollection = edmType.startsWith("Collection(");
  const innerType = isCollection
    ? edmType.replace("Collection(", "").replace(/\)$/, "")
    : edmType;

  // Primitive types
  const primitiveResult = toSwaggerType(innerType);
  const strippedBase = innerType.replace("Edm.", "");
  const PRIMITIVES = new Set([
    "String", "Int32", "Int64", "Boolean", "DateTimeOffset", "Guid",
    "Binary", "Stream", "Double", "Single", "Decimal", "Int16",
    "Byte", "Duration", "Date", "TimeOfDay",
  ]);
  if (innerType.startsWith("Edm.") || PRIMITIVES.has(strippedBase)) {
    return {
      type: primitiveResult,
      ...(isCollection ? { isArray: true } : {}),
    };
  }

  // Enum types
  const enumName = entityNameFromType(innerType);
  const enumValues = enumTypes.get(enumName);
  if (enumValues && enumValues.length > 0) {
    const filtered = enumValues.filter((v) => v !== "unknownFutureValue");
    return {
      type: "string",
      enum: filtered,
      ...(isCollection ? { isArray: true } : {}),
    };
  }

  // Complex types — only resolve when enrichment is enabled
  if (enrichComplexTypes) {
    const complexName = entityNameFromType(innerType);
    const complexType = complexTypes.get(complexName) ?? complexTypes.get(innerType);

    if (complexType) {
      // Cycle detection: if we've seen this type in our ancestry, stop
      if (ancestors.has(complexName) || depth >= MAX_COMPLEX_DEPTH) {
        if (ancestors.has(complexName)) {
          logDebug(`Complex type cycle detected: ${complexName} (ancestors: ${[...ancestors].join(" → ")})`);
        } else {
          logDebug(`Complex type depth limit reached at ${complexName} (depth=${depth})`);
        }
        return {
          type: "string",
          ...(isCollection ? { isArray: true } : {}),
        };
      }

      // Resolve nested properties
      const childAncestors = new Set(ancestors);
      childAncestors.add(complexName);

      const props = ensureArray(complexType.Property);
      const resolvedProps: RequestBodyProperty[] = props.map((p) => {
        const childResult = resolvePropertySchema(
          p["@_Type"],
          complexTypes,
          enumTypes,
          enrichComplexTypes,
          childAncestors,
          depth + 1
        );
        return {
          name: p["@_Name"],
          description: formatParamDescription(p["@_Name"]),
          type: childResult.type ?? "string",
          ...(childResult.enum ? { enum: childResult.enum } : {}),
          ...(childResult.isArray ? { isArray: true } : {}),
          ...(childResult.properties ? { properties: childResult.properties } : {}),
        };
      });

      return {
        type: "object",
        properties: resolvedProps,
        ...(isCollection ? { isArray: true } : {}),
      };
    }
  }

  // Fallback: unknown type → "string"
  return {
    type: "string",
    ...(isCollection ? { isArray: true } : {}),
  };
}

function entityNameFromType(fullType: string): string {
  const parts = fullType.split(".");
  return parts[parts.length - 1] ?? fullType;
}

/**
 * Build request body properties from the CSDL entity type definition.
 * Resolves enum values for properties whose type maps to a known EnumType.
 * Excludes read-only / server-managed properties (id, createdDateTime, etc.).
 */
function buildEntityBodyProperties(
  entityTypeName: string,
  entityTypes: Map<string, CsdlEntityType>,
  enumTypes: Map<string, string[]>,
  complexTypes: Map<string, CsdlEntityType> = new Map(),
  enrichComplexTypes: boolean = false
): RequestBodyProperty[] {
  const entityType = entityTypes.get(entityTypeName);
  if (!entityType) return [];

  // Universally server-managed properties — never writable on any entity.
  const READONLY_PROPS = new Set([
    "id", "createdDateTime", "lastModifiedDateTime",
    "createdBy", "lastModifiedBy",
  ]);

  // Suffix patterns that indicate server-computed output-only properties.
  // These are set by the server after creation (status, download URLs, timestamps).
  const READONLY_SUFFIXES = ["Status", "Url", "Uri"];

  // Exact-match patterns for common server-set timestamps beyond created/lastModified.
  const READONLY_PATTERNS = new Set([
    "requestDateTime", "expirationDateTime", "completedDateTime",
  ]);

  function isServerManaged(name: string): boolean {
    if (READONLY_PROPS.has(name)) return true;
    if (READONLY_PATTERNS.has(name)) return true;
    for (const suffix of READONLY_SUFFIXES) {
      if (name.endsWith(suffix)) return true;
    }
    return false;
  }

  const props = ensureArray(entityType.Property);
  return props
    .filter((p) => !isServerManaged(p["@_Name"]))
    .map((p) => {
      const edmType = p["@_Type"];
      const isCollection = edmType.startsWith("Collection(");

      // Determine nullable: Collections default to non-nullable (false),
      // scalar properties default to nullable (true) per OData conventions.
      // Explicit @_Nullable attribute overrides the default.
      const explicitNullable = p["@_Nullable"];
      let nullable: boolean;
      if (explicitNullable !== undefined) {
        nullable = explicitNullable !== "false";
      } else {
        nullable = !isCollection; // collections default non-nullable, scalars default nullable
      }

      // Use shared resolver for type resolution (handles primitives, enums, complex types)
      const resolved = resolvePropertySchema(
        edmType, complexTypes, enumTypes, enrichComplexTypes
      );

      return {
        name: p["@_Name"],
        type: resolved.type ?? "string",
        description: formatParamDescription(p["@_Name"]),
        nullable,
        ...(resolved.isArray ? { isArray: true } : {}),
        ...(resolved.enum ? { enum: resolved.enum } : {}),
        ...(resolved.properties ? { properties: resolved.properties } : {}),
      };
    });
}

function buildOperationsFromEntitySet(
  setName: string,
  entityTypeName: string,
  entityTypes: Map<string, CsdlEntityType>,
  version: string,
  enumTypes: Map<string, string[]> = new Map(),
  complexTypes: Map<string, CsdlEntityType> = new Map(),
  enrichComplexTypes: boolean = false
): GraphOperationInfo[] {
  const operations: GraphOperationInfo[] = [];
  const basePath = `/${setName}`;
  const itemPath = `/${setName}/{${setName.slice(0, -1)}-id}`;
  const entityType = entityTypes.get(entityTypeName);

  const properties = entityType
    ? ensureArray(entityType.Property).map((p) => p["@_Name"]).join(", ")
    : "unknown";

  // GET collection
  operations.push({
    operationId: `${setName}.list`,
    method: "GET",
    path: basePath,
    summary: `List ${setName}`,
    description: `Retrieve a list of ${setName}. Properties: ${properties}`,
    parameters: buildStandardQueryParams(),
    requiredScopes: inferScopes(entityTypeName, setName, "read"),
    requestBodySummary: null,
    responseSummary: `Collection of ${entityTypeName} objects`,
  });

  // GET single item
  operations.push({
    operationId: `${setName}.get`,
    method: "GET",
    path: itemPath,
    summary: `Get ${entityTypeName}`,
    description: `Retrieve a single ${entityTypeName} by ID.`,
    parameters: [
      {
        name: `${setName.slice(0, -1)}-id`,
        in: "path",
        required: true,
        type: "string",
        description: `The unique identifier of the ${entityTypeName}.`,
      },
      ...buildStandardQueryParams(),
    ],
    requiredScopes: inferScopes(entityTypeName, setName, "read"),
    requestBodySummary: null,
    responseSummary: `${entityTypeName} object`,
  });

  // POST create
  const bodyProps = buildEntityBodyProperties(entityTypeName, entityTypes, enumTypes, complexTypes, enrichComplexTypes);
  const createOp: GraphOperationInfo = {
    operationId: `${setName}.create`,
    method: "POST",
    path: basePath,
    summary: `Create ${entityTypeName}`,
    description: `Create a new ${entityTypeName}.`,
    parameters: [],
    requiredScopes: inferScopes(entityTypeName, setName, "write"),
    requestBodySummary: `${entityTypeName} object`,
    responseSummary: `Created ${entityTypeName} object`,
  };
  operations.push(
    bodyProps.length > 0
      ? { ...createOp, requestBodyProperties: bodyProps }
      : createOp
  );

  // PATCH update
  const updateOp: GraphOperationInfo = {
    operationId: `${setName}.update`,
    method: "PATCH",
    path: itemPath,
    summary: `Update ${entityTypeName}`,
    description: `Update an existing ${entityTypeName}.`,
    parameters: [
      {
        name: `${setName.slice(0, -1)}-id`,
        in: "path",
        required: true,
        type: "string",
        description: `The unique identifier of the ${entityTypeName}.`,
      },
    ],
    requiredScopes: inferScopes(entityTypeName, setName, "write"),
    requestBodySummary: `${entityTypeName} object (partial)`,
    responseSummary: `Updated ${entityTypeName} object`,
  };
  operations.push(
    bodyProps.length > 0
      ? { ...updateOp, requestBodyProperties: bodyProps }
      : updateOp
  );

  // DELETE
  operations.push({
    operationId: `${setName}.delete`,
    method: "DELETE",
    path: itemPath,
    summary: `Delete ${entityTypeName}`,
    description: `Delete an existing ${entityTypeName}.`,
    parameters: [
      {
        name: `${setName.slice(0, -1)}-id`,
        in: "path",
        required: true,
        type: "string",
        description: `The unique identifier of the ${entityTypeName}.`,
      },
    ],
    requiredScopes: inferScopes(entityTypeName, setName, "write"),
    requestBodySummary: null,
    responseSummary: "No content (204)",
  });

  return operations;
}

function buildStandardQueryParams(): GraphOperationParameter[] {
  return [
    { name: "$select", in: "query", required: false, type: "string", description: "Comma-separated list of properties to include in the response." },
    { name: "$filter", in: "query", required: false, type: "string", description: "OData filter expression." },
    { name: "$top", in: "query", required: false, type: "integer", description: "Maximum number of results to return." },
    { name: "$skip", in: "query", required: false, type: "integer", description: "Number of results to skip." },
    { name: "$orderby", in: "query", required: false, type: "string", description: "Order results by a property." },
    { name: "$expand", in: "query", required: false, type: "string", description: "Comma-separated list of relationships to expand." },
  ];
}

// ─── Navigation path resolution ─────────────────────────────────────────────

interface NavigationResolution {
  readonly entityTypeName: string;
  readonly isCollection: boolean;
  readonly basePath: string;
  readonly collectionSegment: string;
  /** True when the final navigation property has ContainsTarget="true" (contained entity). */
  readonly isContained: boolean;
}

/**
 * Resolves a multi-segment endpoint path by following singleton → navigation property chains.
 * Example: "/deviceManagement/managedDevices" →
 *   1. deviceManagement singleton → deviceManagement entity type
 *   2. managedDevices nav property → Collection(managedDevice)
 *   Returns { entityTypeName: "managedDevice", isCollection: true, basePath: "/deviceManagement/managedDevices", collectionSegment: "managedDevices" }
 */
function resolveNavigationPath(
  segments: string[],
  entityTypes: Map<string, CsdlEntityType>,
  singletons: Map<string, string>,
  entitySets: Map<string, string>
): NavigationResolution | null {
  if (segments.length === 0) return null;

  const firstSegment = segments[0]!;
  const firstLower = firstSegment.toLowerCase();

  // Find starting entity type from singleton or entity set (case-insensitive)
  let currentTypeName: string | undefined;
  let isCollection = false;

  for (const [name, fullType] of singletons.entries()) {
    if (name.toLowerCase() === firstLower) {
      currentTypeName = entityNameFromType(fullType);
      isCollection = false;
      break;
    }
  }

  if (!currentTypeName) {
    for (const [name, fullType] of entitySets.entries()) {
      if (name.toLowerCase() === firstLower) {
        currentTypeName = entityNameFromType(fullType);
        isCollection = true;
        break;
      }
    }
  }

  if (!currentTypeName) return null;

  // Follow remaining segments through navigation properties
  let resolvedPath = `/${firstSegment}`;
  let lastCollectionSegment = firstSegment;
  let isContained = false;

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!;
    const currentType = entityTypes.get(currentTypeName);
    if (!currentType) return null;

    // Look for a navigation property matching this segment
    const navProps = ensureArray(currentType.NavigationProperty);
    const matchingNav = navProps.find(
      (np) => np["@_Name"].toLowerCase() === segment.toLowerCase()
    );

    if (!matchingNav) return null;

    const navType = matchingNav["@_Type"];
    const navIsCollection = navType.startsWith("Collection(");
    const resolvedTypeName = entityNameFromType(
      navIsCollection ? navType.replace("Collection(", "").replace(")", "") : navType
    );

    currentTypeName = resolvedTypeName;
    isCollection = navIsCollection;
    isContained = matchingNav["@_ContainsTarget"] === "true";
    resolvedPath += `/${segment}`;
    lastCollectionSegment = segment;
  }

  return {
    entityTypeName: currentTypeName,
    isCollection,
    basePath: resolvedPath,
    collectionSegment: lastCollectionSegment,
    isContained,
  };
}

// ─── Bound action operations ────────────────────────────────────────────────

function buildBoundActionOperations(
  entityTypeName: string,
  actions: CsdlAction[],
  basePath: string,
  collectionSegment: string,
  namespaces: string[],
  aliases: string[] = [],
  enumTypes: Map<string, string[]> = new Map(),
  isSingleton: boolean = false,
  complexTypes: Map<string, CsdlEntityType> = new Map(),
  enrichComplexTypes: boolean = false
): GraphOperationInfo[] {
  const operations: GraphOperationInfo[] = [];

  // Build all possible fully-qualified binding type names
  // Include namespace-qualified AND alias-qualified forms
  // (CSDL uses aliases like "graph.managedDevice" for "microsoft.graph.managedDevice")
  const bindingTypeNames = new Set<string>();
  bindingTypeNames.add(entityTypeName.toLowerCase());
  for (const ns of namespaces) {
    bindingTypeNames.add(`${ns}.${entityTypeName}`.toLowerCase());
  }
  for (const alias of aliases) {
    bindingTypeNames.add(`${alias}.${entityTypeName}`.toLowerCase());
  }

  for (const action of actions) {
    if (action["@_IsBound"] !== "true") continue;

    const params = ensureArray(action.Parameter);
    const bindingParam = params[0]; // First parameter is always the binding parameter
    if (!bindingParam) continue;

    const bindingType = bindingParam["@_Type"].toLowerCase();
    if (!bindingTypeNames.has(bindingType)) continue;

    const actionName = action["@_Name"];
    const friendlyEntity = formatActionName(singularize(collectionSegment));

    // Singletons: action path is basePath/actionName (no {id} segment)
    // Collections: action path is basePath/{id}/actionName
    let actionPath: string;
    const pathParams: GraphOperationParameter[] = [];
    if (isSingleton) {
      actionPath = `${basePath}/${actionName}`;
    } else {
      const idParam = `${singularize(collectionSegment)}-id`;
      actionPath = `${basePath}/{${idParam}}/${actionName}`;
      pathParams.push({
        name: idParam,
        in: "path" as const,
        required: true,
        type: "string",
        description: `The unique identifier of the ${friendlyEntity.toLowerCase()}.`,
      });
    }

    // Non-binding parameters become the request body
    const nonBindingParams = params.slice(1);
    const hasBody = nonBindingParams.length > 0;
    const bodyDescription = hasBody
      ? `Parameters: ${nonBindingParams.map((p) => p["@_Name"]).join(", ")}`
      : null;

    const bodyProperties: RequestBodyProperty[] = nonBindingParams.map((p) => {
      const resolved = resolvePropertySchema(
        p["@_Type"], complexTypes, enumTypes, enrichComplexTypes
      );
      return {
        name: p["@_Name"],
        type: resolved.type ?? "string",
        description: formatParamDescription(p["@_Name"]),
        ...(resolved.isArray ? { isArray: true } : {}),
        ...(resolved.enum ? { enum: resolved.enum } : {}),
        ...(resolved.properties ? { properties: resolved.properties } : {}),
      };
    });

    const baseOp = {
      operationId: `${collectionSegment}.${actionName}`,
      method: "POST",
      path: actionPath,
      summary: `${formatActionName(actionName)} ${friendlyEntity}`,
      description: `Invoke the ${actionName} action on a ${friendlyEntity.toLowerCase()}.${
        hasBody ? ` Parameters: ${nonBindingParams.map((p) => `${p["@_Name"]} (${toSwaggerType(p["@_Type"])})`).join(", ")}` : ""
      }`,
      parameters: pathParams,
      requiredScopes: inferScopes(entityTypeName, collectionSegment, "action"),
      requestBodySummary: bodyDescription,
      responseSummary: null,
    };

    operations.push(
      hasBody
        ? { ...baseOp, requestBodyProperties: bodyProperties }
        : baseOp
    );
  }

  return operations;
}

function formatParamDescription(name: string): string {
  // camelCase → lower spaced: "keepEnrollmentData" → "Keep enrollment data"
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function singularize(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes")) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

function formatActionName(name: string): string {
  // camelCase → Title Case: "rebootNow" → "Reboot Now"
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Well-known Graph API scope prefixes for common entity types.
 * Maps entity type names to their permission scope prefixes.
 */
const SCOPE_PREFIX_MAP: Record<string, string> = {
  managedDevice: "DeviceManagementManagedDevices",
  deviceCompliancePolicy: "DeviceManagementConfiguration",
  deviceConfiguration: "DeviceManagementConfiguration",
  mobileApp: "DeviceManagementApps",
  roleAssignment: "DeviceManagementRBAC",
  roleDefinition: "DeviceManagementRBAC",
  deviceEnrollmentConfiguration: "DeviceManagementServiceConfig",
  termsAndConditions: "DeviceManagementServiceConfig",
};

/**
 * Prefix-based scope mappings for entity type families.
 * All entity types whose names start with a given prefix (case-insensitive)
 * are mapped to the same permission scope prefix.
 */
const SCOPE_PREFIX_PATTERNS: Array<{ prefix: string; scopePrefix: string }> = [
  { prefix: "cloudPc", scopePrefix: "CloudPC" },
];

/**
 * Infer permission scopes for an entity type.
 * Uses well-known mappings for Intune/device management entities,
 * then prefix-pattern matching for entity type families (e.g., cloudPc*),
 * and falls back to `{EntityTypeName}.Read.All` / `.ReadWrite.All` pattern.
 */
function inferScopes(
  entityTypeName: string,
  _collectionSegment: string,
  level: "read" | "write" | "action"
): string[] {
  // Exact match in well-known map
  const prefix = SCOPE_PREFIX_MAP[entityTypeName];
  if (prefix) {
    return level === "read"
      ? [`${prefix}.Read.All`]
      : [`${prefix}.ReadWrite.All`];
  }

  // Prefix-pattern match for entity type families
  const nameLower = entityTypeName.toLowerCase();
  for (const pattern of SCOPE_PREFIX_PATTERNS) {
    if (nameLower.startsWith(pattern.prefix.toLowerCase())) {
      return level === "read"
        ? [`${pattern.scopePrefix}.Read.All`]
        : [`${pattern.scopePrefix}.ReadWrite.All`];
    }
  }

  // Generic fallback: capitalise entity type name
  const cap = entityTypeName.charAt(0).toUpperCase() + entityTypeName.slice(1);
  return level === "read"
    ? [`${cap}.Read.All`]
    : [`${cap}.ReadWrite.All`];
}

export function parseCsdlToOperations(
  xml: string,
  endpointFilter: string,
  enrichComplexTypes: boolean = false
): { operations: GraphOperationInfo[]; warnings: string[] } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["EntitySet", "Singleton", "EntityType", "ComplexType", "Property", "NavigationProperty", "EnumType", "Member", "Action", "Function", "Parameter"].includes(name),
  });

  const parsed = parser.parse(xml);
  const warnings: string[] = [];

  // Navigate CSDL structure
  const edmx = parsed["edmx:Edmx"] ?? parsed["Edmx"];
  if (!edmx) {
    warnings.push("Could not find edmx:Edmx root element.");
    return { operations: [], warnings };
  }

  const dataServices = edmx["edmx:DataServices"] ?? edmx["DataServices"];
  if (!dataServices) {
    warnings.push("Could not find DataServices element.");
    return { operations: [], warnings };
  }

  const schemas = ensureArray(dataServices["Schema"]);
  
  // Collect entity types
  const entityTypes = new Map<string, CsdlEntityType>();
  // Collect complex types (same structure as entity types: have Property elements)
  const complexTypes = new Map<string, CsdlEntityType>();
  // Collect namespaces AND aliases for action binding resolution
  const namespaces: string[] = [];
  const aliases: string[] = [];
  // Collect all bound actions
  const allActions: CsdlAction[] = [];
  // Collect enum types for parameter value resolution
  const enumTypes = new Map<string, string[]>(); // short name → member values

  for (const schema of schemas) {
    const ns = schema["@_Namespace"] as string | undefined;
    if (ns) namespaces.push(ns);
    const alias = schema["@_Alias"] as string | undefined;
    if (alias) aliases.push(alias);

    const types = ensureArray(schema["EntityType"] as CsdlEntityType | CsdlEntityType[] | undefined);
    for (const et of types) {
      const shortName = et["@_Name"];
      // Store by namespace-qualified name for precise lookups
      if (ns) entityTypes.set(`${ns}.${shortName}`, et);
      // Store by short name — prefer microsoft.graph namespace on conflicts
      if (!entityTypes.has(shortName) || ns === "microsoft.graph") {
        entityTypes.set(shortName, et);
      }
    }

    // Collect complex types (reuse CsdlEntityType — both have Property elements)
    const ctypes = ensureArray(schema["ComplexType"] as CsdlEntityType | CsdlEntityType[] | undefined);
    for (const ct of ctypes) {
      const shortName = ct["@_Name"];
      if (ns) complexTypes.set(`${ns}.${shortName}`, ct);
      if (!complexTypes.has(shortName) || ns === "microsoft.graph") {
        complexTypes.set(shortName, ct);
      }
    }

    // Collect enum types
    const enums = ensureArray(schema["EnumType"] as CsdlEnumType | CsdlEnumType[] | undefined);
    for (const en of enums) {
      const members = ensureArray(en.Member).map((m) => m["@_Name"]);
      enumTypes.set(en["@_Name"], members);
    }

    // Collect bound actions
    const actions = ensureArray(schema["Action"] as CsdlAction | CsdlAction[] | undefined);
    allActions.push(...actions);
  }

  // Build lookup maps for singletons and entity sets (original-case keys)
  const singletonMap = new Map<string, string>(); // original name → full type
  const entitySetMap = new Map<string, string>(); // original name → full entity type

  // Collect entity sets and singletons from EntityContainer
  const allOperations: GraphOperationInfo[] = [];
  const filterLower = endpointFilter.replace(/^\//, "").toLowerCase();
  const filterSegments = endpointFilter.replace(/^\//, "").split("/").filter((s) => s.length > 0);

  for (const schema of schemas) {
    const containers = ensureArray(schema["EntityContainer"]);
    for (const container of containers) {
      // Entity sets
      const sets = ensureArray(container["EntitySet"] as CsdlEntitySet | CsdlEntitySet[] | undefined);
      for (const es of sets) {
        entitySetMap.set(es["@_Name"], es["@_EntityType"]);
      }

      // Singletons
      const singletons = ensureArray(container["Singleton"] as CsdlSingleton | CsdlSingleton[] | undefined);
      for (const s of singletons) {
        singletonMap.set(s["@_Name"], s["@_Type"]);
      }
    }
  }

  // Check if this is a multi-segment navigation path (e.g., /deviceManagement/managedDevices)
  if (filterSegments.length >= 2) {
    const resolution = resolveNavigationPath(filterSegments, entityTypes, singletonMap, entitySetMap);
    if (resolution) {
      if (resolution.isCollection) {
        // Generate CRUD operations with the full navigation path
        const ops = buildOperationsFromNavigationPath(
          resolution.basePath,
          resolution.collectionSegment,
          resolution.entityTypeName,
          entityTypes,
          enumTypes,
          resolution.isContained,
          complexTypes,
          enrichComplexTypes
        );
        allOperations.push(...ops);

        if (resolution.isContained) {
          warnings.push(
            `"${resolution.collectionSegment}" is a contained entity (ContainsTarget="true"). ` +
            `All CRUD operations are generated. Some contained collections may not support ` +
            `all HTTP methods — verify against the Graph API documentation if you encounter 405 errors.`
          );
        }

        // Generate bound action operations
        const actionOps = buildBoundActionOperations(
          resolution.entityTypeName,
          allActions,
          resolution.basePath,
          resolution.collectionSegment,
          namespaces,
          aliases,
          enumTypes,
          false,
          complexTypes,
          enrichComplexTypes
        );
        allOperations.push(...actionOps);
      } else {
        // Single entity at end of path — GET only (like a singleton)
        allOperations.push({
          operationId: `${resolution.collectionSegment}.get`,
          method: "GET",
          path: resolution.basePath,
          summary: `Get ${resolution.entityTypeName}`,
          description: `Retrieve the ${resolution.entityTypeName}.`,
          parameters: buildStandardQueryParams(),
          requiredScopes: inferScopes(resolution.entityTypeName, resolution.collectionSegment, "read"),
          requestBodySummary: null,
          responseSummary: `${resolution.entityTypeName} object`,
        });

        // Discover bound actions for this singleton entity type
        const singletonActionOps = buildBoundActionOperations(
          resolution.entityTypeName,
          allActions,
          resolution.basePath,
          resolution.collectionSegment,
          namespaces,
          aliases,
          enumTypes,
          true, // singleton — no {id} segment in action paths
          complexTypes,
          enrichComplexTypes
        );
        allOperations.push(...singletonActionOps);
      }
    }
  }

  // If no multi-segment match found (or single segment), fall back to direct matching
  if (allOperations.length === 0) {
    for (const [setName, fullType] of entitySetMap.entries()) {
      const setNameLower = setName.toLowerCase();
      if (filterLower === "" || setNameLower.startsWith(filterLower) || filterLower.startsWith(setNameLower)) {
        const entityTypeName = entityNameFromType(fullType);
        const ops = buildOperationsFromEntitySet(setName, entityTypeName, entityTypes, "v1.0", enumTypes, complexTypes, enrichComplexTypes);
        allOperations.push(...ops);

        // Discover bound actions for this entity type
        const actionOps = buildBoundActionOperations(
          entityTypeName,
          allActions,
          `/${setName}`,
          setName,
          namespaces,
          aliases,
          enumTypes,
          false,
          complexTypes,
          enrichComplexTypes
        );
        allOperations.push(...actionOps);
      }
    }

    // Singletons (only for single-segment paths)
    if (filterSegments.length <= 1) {
      for (const [sName, fullType] of singletonMap.entries()) {
        const sNameLower = sName.toLowerCase();
        if (filterLower === "" || sNameLower.startsWith(filterLower) || filterLower.startsWith(sNameLower)) {
          const entityTypeName = entityNameFromType(fullType);
          allOperations.push({
            operationId: `${sName}.get`,
            method: "GET",
            path: `/${sName}`,
            summary: `Get ${sName}`,
            description: `Retrieve the ${sName} singleton.`,
            parameters: buildStandardQueryParams(),
            requiredScopes: [`${entityTypeName}.Read.All`],
            requestBodySummary: null,
            responseSummary: `${entityTypeName} object`,
          });
        }
      }
    }
  }

  if (allOperations.length === 0) {
    warnings.push(`No operations found matching endpoint filter '${endpointFilter}'.`);
  }

  return { operations: allOperations, warnings };
}

/**
 * Build CRUD operations for a collection reached via a navigation path.
 * basePath is the full path (e.g., "/deviceManagement/managedDevices").
 *
 * When `isContained` is true the collection lives inside its parent entity
 * (CSDL ContainsTarget="true").  All 5 CRUD operations (list, get, create,
 * update, delete) are generated regardless of containment — the Graph API
 * supports listing and mutating most contained collections (e.g. cloudPCs,
 * exportJobs).  An informational warning is emitted so the user can verify
 * support against the Graph API documentation.
 */
function buildOperationsFromNavigationPath(
  basePath: string,
  collectionSegment: string,
  entityTypeName: string,
  entityTypes: Map<string, CsdlEntityType>,
  enumTypes: Map<string, string[]> = new Map(),
  isContained: boolean = false,
  complexTypes: Map<string, CsdlEntityType> = new Map(),
  enrichComplexTypes: boolean = false
): GraphOperationInfo[] {
  const operations: GraphOperationInfo[] = [];
  const idParam = `${singularize(collectionSegment)}-id`;
  const itemPath = `${basePath}/{${idParam}}`;
  const entityType = entityTypes.get(entityTypeName);

  const properties = entityType
    ? ensureArray(entityType.Property).map((p) => p["@_Name"]).join(", ")
    : "unknown";

  // GET collection — always generated.
  // ContainsTarget means entities don't have a standalone entity set,
  // but the Graph API still supports listing contained collections
  // (e.g. /deviceManagement/virtualEndpoint/cloudPCs).
  operations.push({
    operationId: `${collectionSegment}.list`,
    method: "GET",
    path: basePath,
    summary: `List ${collectionSegment}`,
    description: `Retrieve a list of ${collectionSegment}. Properties: ${properties}`,
    parameters: buildStandardQueryParams(),
    requiredScopes: inferScopes(entityTypeName, collectionSegment, "read"),
    requestBodySummary: null,
    responseSummary: `Collection of ${entityTypeName} objects`,
  });

  // GET single item
  operations.push({
    operationId: `${collectionSegment}.get`,
    method: "GET",
    path: itemPath,
    summary: `Get ${entityTypeName}`,
    description: `Retrieve a single ${entityTypeName} by ID.`,
    parameters: [
      {
        name: idParam,
        in: "path",
        required: true,
        type: "string",
        description: `The unique identifier of the ${entityTypeName}.`,
      },
      ...buildStandardQueryParams(),
    ],
    requiredScopes: inferScopes(entityTypeName, collectionSegment, "read"),
    requestBodySummary: null,
    responseSummary: `${entityTypeName} object`,
  });

  // POST create
  const bodyProps = buildEntityBodyProperties(entityTypeName, entityTypes, enumTypes, complexTypes, enrichComplexTypes);
  const createOp: GraphOperationInfo = {
    operationId: `${collectionSegment}.create`,
    method: "POST",
    path: basePath,
    summary: `Create ${entityTypeName}`,
    description: `Create a new ${entityTypeName}.`,
    parameters: [],
    requiredScopes: inferScopes(entityTypeName, collectionSegment, "write"),
    requestBodySummary: bodyProps.length > 0
      ? `Parameters: ${bodyProps.map((p) => p.name).join(", ")}`
      : `${entityTypeName} object`,
    responseSummary: `Created ${entityTypeName} object`,
  };
  operations.push(
    bodyProps.length > 0
      ? { ...createOp, requestBodyProperties: bodyProps }
      : createOp
  );

  // PATCH update — generated for all collections including contained entities.
  // ContainsTarget does not restrict PATCH operations in Graph API.
  const updateOp: GraphOperationInfo = {
    operationId: `${collectionSegment}.update`,
    method: "PATCH",
    path: itemPath,
    summary: `Update ${entityTypeName}`,
    description: `Update an existing ${entityTypeName}.`,
    parameters: [
      {
        name: idParam,
        in: "path",
        required: true,
        type: "string",
        description: `The unique identifier of the ${entityTypeName}.`,
      },
    ],
    requiredScopes: inferScopes(entityTypeName, collectionSegment, "write"),
    requestBodySummary: bodyProps.length > 0
      ? `Parameters: ${bodyProps.map((p) => p.name).join(", ")}`
      : `${entityTypeName} object (partial)`,
    responseSummary: `Updated ${entityTypeName} object`,
  };
  operations.push(
    bodyProps.length > 0
      ? { ...updateOp, requestBodyProperties: bodyProps }
      : updateOp
  );

  // DELETE — generated for all collections including contained entities.
  operations.push({
    operationId: `${collectionSegment}.delete`,
    method: "DELETE",
    path: itemPath,
    summary: `Delete ${entityTypeName}`,
    description: `Delete an existing ${entityTypeName}.`,
    parameters: [
      {
        name: idParam,
        in: "path",
        required: true,
        type: "string",
        description: `The unique identifier of the ${entityTypeName}.`,
      },
    ],
    requiredScopes: inferScopes(entityTypeName, collectionSegment, "write"),
    requestBodySummary: null,
    responseSummary: "No content (204)",
  });

  return operations;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface MetadataProviderConfig {
  readonly version: string;
  readonly cachePath: string;
  readonly csdlCacheTtlHours: number;
  readonly hidiCliPath: string | null;
  readonly forceRefresh: boolean;
  /** When true, resolve CSDL ComplexTypes into nested schemas instead of flattening to "string". */
  readonly enrichComplexTypes?: boolean;
}

export async function getOperationsForEndpoint(
  endpoint: string,
  config: MetadataProviderConfig
): Promise<{ operations: GraphOperationInfo[]; cacheAge: string; warnings: string[] }> {
  const { xml, cacheAge } = await loadCsdl(
    config.version,
    config.cachePath,
    config.csdlCacheTtlHours,
    config.forceRefresh
  );

  // Try hidi first if available
  const hidiPath = detectHidi(config.hidiCliPath);
  if (hidiPath) {
    try {
      const entityFilter = endpoint.replace(/^\//, "").split("/")[0] ?? "";
      const csdlUrl = `https://graph.microsoft.com/${config.version}/$metadata`;
      const swaggerJson = await convertCsdlWithHidi(csdlUrl, entityFilter, hidiPath);
      const parsed = JSON.parse(swaggerJson);
      
      // Extract operations from hidi-generated Swagger
      const operations = extractOperationsFromSwagger(parsed, endpoint);
      return { operations, cacheAge, warnings: ["Converted via hidi CLI."] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`hidi conversion failed, falling back to pure-TS: ${msg}`);
    }
  }

  // Pure-TS fallback
  const { operations, warnings } = parseCsdlToOperations(xml, endpoint, config.enrichComplexTypes ?? false);
  return { operations, cacheAge, warnings };
}

function extractOperationsFromSwagger(
  swagger: Record<string, unknown>,
  endpointFilter: string
): GraphOperationInfo[] {
  const paths = swagger["paths"] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const filterLower = endpointFilter.toLowerCase();
  const operations: GraphOperationInfo[] = [];

  for (const [pathKey, methods] of Object.entries(paths)) {
    if (!pathKey.toLowerCase().startsWith(filterLower)) continue;

    for (const [method, details] of Object.entries(methods)) {
      if (typeof details !== "object" || details === null) continue;
      const d = details as Record<string, unknown>;

      const params = ensureArray(d["parameters"] as unknown[]).map((p) => {
        const param = p as Record<string, unknown>;
        return {
          name: String(param["name"] ?? ""),
          in: String(param["in"] ?? "query") as "path" | "query" | "header",
          required: Boolean(param["required"]),
          type: String(param["type"] ?? "string"),
          description: String(param["description"] ?? ""),
        };
      });

      operations.push({
        operationId: String(d["operationId"] ?? `${method}.${pathKey}`),
        method: method.toUpperCase(),
        path: pathKey,
        summary: String(d["summary"] ?? ""),
        description: String(d["description"] ?? ""),
        parameters: params,
        requiredScopes: [],
        requestBodySummary: d["requestBody"] ? "Request body required" : null,
        responseSummary: d["responses"] ? "See response schema" : null,
      });
    }
  }

  return operations;
}
