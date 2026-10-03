interface StructuredOutputDefinition {
  schema_id: string;
  schema: Record<string, unknown>;
}

export function validateStructuredOutput(
  value: unknown,
  definition: StructuredOutputDefinition,
): string | null {
  const errors: string[] = [];
  validateSchema(value, definition.schema, "$", errors);
  return errors[0] ?? null;
}

function validateSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const alternatives = anyOf.filter(isRecord);
    if (alternatives.length > 0) {
      const branchErrors: string[] = [];
      const matched = alternatives.some((alternative, index) => {
        const alternativeErrors: string[] = [];
        validateSchema(value, alternative, path, alternativeErrors);
        if (alternativeErrors.length === 0) return true;
        branchErrors.push(`${index}=${alternativeErrors[0]}`);
        return false;
      });
      if (!matched) {
        errors.push(`${path}:anyOf(${branchErrors.join("; ")})`);
        return;
      }
    }
  }

  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${path}:type:${type}`);
    return;
  }
  if (Array.isArray(type) && !type.some((candidate) => typeof candidate === "string" && matchesType(value, candidate))) {
    errors.push(`${path}:type`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path}:enum`);
  }
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value)) {
    errors.push(`${path}:const`);
  }
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path}:minLength`);
  }
  if (typeof schema.maxLength === "number" && typeof value === "string" && value.length > schema.maxLength) {
    errors.push(`${path}:maxLength`);
  }
  if (typeof schema.pattern === "string" && typeof value === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}:pattern`);
    } catch {
      errors.push(`${path}:invalidPattern`);
    }
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}:minimum`);
  }
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path}:maximum`);
  }
  if (typeof schema.minItems === "number" && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${path}:minItems`);
  }
  if (typeof schema.maxItems === "number" && Array.isArray(value) && value.length > schema.maxItems) {
    errors.push(`${path}:maxItems`);
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => validateSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`, errors));
  }
  if (!isRecord(value)) return;

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !Object.hasOwn(value, key)) errors.push(`${path}.${key}:required`);
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key) && isRecord(childSchema)) {
      validateSchema(value[key], childSchema, `${path}.${key}`, errors);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}:additionalProperties`);
    }
  }
}

function validateAlternative(value: unknown, schema: Record<string, unknown>): boolean {
  const errors: string[] = [];
  validateSchema(value, schema, "$", errors);
  return errors.length === 0;
}

/**
 * Providers without constrained decoding often emit a near-miss for a
 * nullable-union slot ({}, "", "null", or an all-null object) instead of the
 * literal null. Coerce those to null, but only where the schema's anyOf has a
 * null branch and the value matches no branch as-is; schema-valid values are
 * never touched.
 */
export function normalizeNullableNearMisses(
  value: unknown,
  schema: Record<string, unknown>,
): { value: unknown; changed: boolean } {
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isRecord) : [];
  if (anyOf.length > 0) {
    if (anyOf.some((alternative) => validateAlternative(value, alternative))) return { value, changed: false };
    if (anyOf.some((alternative) => alternative.type === "null") && isNearMissNull(value)) {
      return { value: null, changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    const items = schema.items;
    let changed = false;
    const normalized = value.map((item) => {
      const result = normalizeNullableNearMisses(item, items);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? normalized : value, changed };
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    const properties = schema.properties;
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const childSchema = properties[key];
      if (!isRecord(childSchema)) return [key, item] as const;
      const result = normalizeNullableNearMisses(item, childSchema);
      changed = changed || result.changed;
      return [key, result.value] as const;
    });
    return { value: changed ? Object.fromEntries(entries) : value, changed };
  }
  return { value, changed: false };
}

/**
 * XML-to-JSON tool-call gateways (observed with MiniMax's OpenAI-compatible
 * layer) stringify every scalar ("true", "4") and represent arrays as a
 * single-key `{ item: … }` element list. Undo both, guided by the schema so
 * legitimate string fields and `item`-named properties are never touched.
 */
export function normalizeGatewayShapes(
  value: unknown,
  schema: Record<string, unknown>,
): { value: unknown; changed: boolean } {
  const expected = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((expected.includes("integer") || expected.includes("number")) && trimmed !== "" && Number.isFinite(Number(trimmed))) {
      const numeric = Number(trimmed);
      if (!expected.includes("integer") || Number.isInteger(numeric)) return { value: numeric, changed: true };
    }
    if (expected.includes("boolean") && (trimmed === "true" || trimmed === "false")) {
      return { value: trimmed === "true", changed: true };
    }
    return { value, changed: false };
  }
  if (expected.includes("string") && isRecord(value)) {
    // Sloppy emitters wrap plain strings in a one-field object
    // (e.g. issues: [{"issue": "text"}] where the schema wants ["text"]).
    const entries = Object.values(value);
    if (entries.length === 1 && typeof entries[0] === "string") return { value: entries[0], changed: true };
  }
  if (expected.includes("array") && isRecord(value) && Object.keys(value).length === 1 && "item" in value) {
    const inner = value.item;
    const asArray = Array.isArray(inner) ? inner : [inner];
    return { value: normalizeGatewayShapes(asArray, schema).value, changed: true };
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    const items = schema.items;
    let changed = false;
    const normalized = value.map((item) => {
      const result = normalizeGatewayShapes(item, items);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? normalized : value, changed };
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    const properties = schema.properties;
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const childSchema = properties[key];
      if (!isRecord(childSchema)) return [key, item] as const;
      const result = normalizeGatewayShapes(item, childSchema);
      changed = changed || result.changed;
      return [key, result.value] as const;
    });
    return { value: changed ? Object.fromEntries(entries) : value, changed };
  }
  return { value, changed: false };
}

function isNearMissNull(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" || trimmed === "null" || trimmed === "none";
  }
  return isRecord(value) && Object.values(value).every((item) => item === null);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
