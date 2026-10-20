const MEMWISE_DISPLAY_NAME_KEY = '_displayName';
const MEMWISE_INTENT_KEY = '_intent';

const MEMWISE_DISPLAY_NAME_SCHEMA = {
  type: 'string',
  description: 'MemWise UI metadata: human-friendly action name for display only.',
};

const MEMWISE_INTENT_SCHEMA = {
  type: 'string',
  description: 'MemWise UI metadata: concise tool-call intent for display only.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWithDescriptors<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

/**
 * Return a Pi tool schema that accepts MemWise's root-level metadata fields.
 *
 * Pi validates tool arguments before MemWise's pre-tool-use hook can strip
 * `_displayName` / `_intent`. Built-in Pi tools often use strict schemas with
 * `additionalProperties: false`, so we add those fields as optional root
 * properties at the adapter boundary. Unknown schema shapes are returned
 * unchanged, and upstream-defined metadata properties win if Pi adds them later.
 */
export function allowMemWiseMetadataProperties<T>(schema: T): T {
  if (!isRecord(schema)) return schema;

  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  const nextSchema = cloneWithDescriptors(schema);
  const nextProperties = cloneWithDescriptors(properties);

  if (!(MEMWISE_DISPLAY_NAME_KEY in nextProperties)) {
    nextProperties[MEMWISE_DISPLAY_NAME_KEY] = MEMWISE_DISPLAY_NAME_SCHEMA;
  }
  if (!(MEMWISE_INTENT_KEY in nextProperties)) {
    nextProperties[MEMWISE_INTENT_KEY] = MEMWISE_INTENT_SCHEMA;
  }

  Object.defineProperty(nextSchema, 'properties', {
    value: nextProperties,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return nextSchema as T;
}

/** Strip MemWise-only metadata before invoking the upstream Pi tool implementation. */
export function stripMemWiseMetadata<T>(input: T): T {
  if (!isRecord(input)) return input;
  if (!(MEMWISE_DISPLAY_NAME_KEY in input) && !(MEMWISE_INTENT_KEY in input)) return input;

  const cleanInput = { ...input };
  delete cleanInput[MEMWISE_DISPLAY_NAME_KEY];
  delete cleanInput[MEMWISE_INTENT_KEY];

  return cleanInput as T;
}
