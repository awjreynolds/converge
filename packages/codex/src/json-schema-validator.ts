import { asRecord } from "./decoding.js";

export function matchesJsonSchema(value: unknown, schema: unknown): boolean {
  return validate(value, schema, schema);
}

function validate(value: unknown, schemaValue: unknown, root: unknown): boolean {
  if (schemaValue === true) return true;
  if (schemaValue === false) return false;
  const schema = asRecord(schemaValue);
  if (!schema) return false;

  if (typeof schema.$ref === "string") {
    const target = resolveLocalReference(root, schema.$ref);
    return target !== undefined && validate(value, target, root);
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry) => validate(value, entry, root))) {
    return false;
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => validate(value, entry, root))) {
    return false;
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((entry) => validate(value, entry, root)).length !== 1
  ) {
    return false;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(value, entry))) {
    return false;
  }

  const types = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) return false;

  if (Array.isArray(value)) {
    if (schema.items !== undefined && !value.every((entry) => validate(entry, schema.items, root))) {
      return false;
    }
    return true;
  }

  const record = asRecord(value);
  if (record) {
    const properties = asRecord(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (!required.every((key) => Object.hasOwn(record, key))) return false;
    for (const [key, entry] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) {
        if (!validate(entry, properties[key], root)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        schema.additionalProperties !== undefined &&
        schema.additionalProperties !== true &&
        !validate(entry, schema.additionalProperties, root)
      ) {
        return false;
      }
    }
  }

  return !(typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum);
}

function resolveLocalReference(rootValue: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = rootValue;
  for (const token of reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    current = asRecord(current)?.[token];
    if (current === undefined) return undefined;
  }
  return current;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return asRecord(value) !== undefined;
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
