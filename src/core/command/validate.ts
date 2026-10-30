// Minimal JSON-Schema validator for command params. Covers the subset used by
// our command schemas (object/array/string/number/integer/boolean, enum,
// required, min/max, oneOf, nested properties). Returns a list of error
// strings (empty = valid). Kept dependency-free and small on purpose.

import { JSONSchema } from "./types";

export function validate(schema: JSONSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validate(s, value, path).length === 0);
    if (matches.length === 0) {
      errors.push(`${path}: does not match any allowed shape`);
    }
    return errors;
  }

  const t = schema.type;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    const matches = (one: string): boolean =>
      (one === "object" && isPlainObject(value)) ||
      (one === "array" && Array.isArray(value)) ||
      (one === "string" && typeof value === "string") ||
      (one === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (one === "integer" && Number.isInteger(value)) ||
      (one === "boolean" && typeof value === "boolean") ||
      (one === "null" && value === null);
    if (!types.some(matches)) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${describe(value)}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  }

  if (t === "object" && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required`);
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) errors.push(...validate(sub, obj[key], `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }
  }

  if (t === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items!, item, `${path}[${i}]`)));
  }

  return errors;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
