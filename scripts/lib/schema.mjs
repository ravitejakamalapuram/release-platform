// A deliberately small JSON Schema validator: just the keywords schema/release.schema.json uses.
// Supported: $ref (local #/$defs/...), type, const, enum, pattern, minLength, minimum, maximum,
// required, properties, additionalProperties (bool), items, minItems, uniqueItems, oneOf.
// Returns a list of { path, message } errors; empty means valid.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function resolve(root, schema) {
  if (!schema.$ref) return schema;
  const prefix = '#/$defs/';
  if (!schema.$ref.startsWith(prefix)) throw new Error(`Unsupported $ref ${schema.$ref}`);
  const target = root.$defs?.[schema.$ref.slice(prefix.length)];
  if (!target) throw new Error(`Unknown $ref ${schema.$ref}`);
  return target;
}

export function validate(schema, value, root = schema, path = '$') {
  const s = resolve(root, schema);
  const errors = [];
  const add = (message, at = path) => errors.push({ path: at, message });

  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchesType(value, t))) {
      add(`must be ${types.join(' or ')} (got ${typeOf(value)})`);
      return errors;
    }
  }
  if ('const' in s && value !== s.const) add(`must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) add(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);

  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) add(`must not be empty`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) add(`must match ${s.pattern}${s.patternHint ? ` (${s.patternHint})` : ''}`);
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) add(`must be >= ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) add(`must be <= ${s.maximum}`);
  }

  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) add(`must have at least ${s.minItems} item(s)`);
    if (s.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) add('must not contain duplicates');
    if (s.items) value.forEach((item, i) => errors.push(...validate(s.items, item, root, `${path}[${i}]`)));
  }

  if (typeOf(value) === 'object') {
    for (const key of s.required ?? []) {
      if (!(key in value)) add(`missing required property "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      const child = s.properties?.[key];
      if (child) errors.push(...validate(child, v, root, `${path}.${key}`));
      else if (s.additionalProperties === false) add(`unknown property "${key}"`, `${path}.${key}`);
    }
  }

  if (s.oneOf) {
    const results = s.oneOf.map((branch) => validate(branch, value, root, path));
    const passing = results.filter((r) => r.length === 0).length;
    const kinds = s.oneOf.map((b) => resolve(root, b).properties?.type?.const).filter((k) => k !== undefined);
    if (passing === 0 && kinds.length === s.oneOf.length && !kinds.includes(value?.type)) {
      // Discriminated union on "type": an unknown type is the only useful thing to say.
      add(`must be one of ${kinds.map((k) => JSON.stringify(k)).join(', ')}`, `${path}.type`);
    } else if (passing === 0) {
      // Report the branch that came closest: it is almost always the one the author meant
      // (e.g. the target whose `type` matched), so its errors are the useful ones.
      errors.push(...results.reduce((best, r) => (r.length < best.length ? r : best)));
    } else if (passing > 1) {
      add('matches more than one allowed shape');
    }
  }
  return errors;
}

export function formatErrors(errors) {
  return errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
}
