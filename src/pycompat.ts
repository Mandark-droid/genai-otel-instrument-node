/**
 * The handful of Python string behaviours that end up on the wire.
 *
 * Several span attributes carry text the Python library produces with
 * `json.dumps(...)` or `str(...)`: `llm.tools`, `gen_ai.request.first_message`,
 * and any list an instrumentor hands to the span wrapper (which stringifies it).
 * `JSON.stringify` and `String` give different bytes for the same value - no
 * space after separators, non-ASCII left unescaped, `1e-7` for `1e-07` - so a
 * backend comparing or hashing these attributes would tell the SDKs apart.
 * These helpers produce the Python form.
 */

/** Python float `repr`: JavaScript's shortest round-trip form with a two-digit exponent. */
function pyNumber(value: number, json: boolean): string {
  if (Number.isNaN(value)) return json ? 'NaN' : 'nan';
  if (value === Infinity) return json ? 'Infinity' : 'inf';
  if (value === -Infinity) return json ? '-Infinity' : '-inf';
  return String(value).replace(/e([+-])(\d)$/, 'e$10$2');
}

const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** `json.dumps(str)` with `ensure_ascii=True`: everything outside printable ASCII is `\uXXXX`. */
function jsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    const short = JSON_SHORT_ESCAPES[char];
    if (short !== undefined) out += short;
    else {
      const code = value.charCodeAt(i);
      // Per UTF-16 code unit, so a character outside the BMP becomes a surrogate pair.
      out += code >= 0x20 && code <= 0x7e ? char : `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return `${out}"`;
}

function dumps(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return jsonString(value);
    case 'number':
      return pyNumber(value, true);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
  }
  const object = value as object;
  if (typeof (object as { toJSON?: unknown }).toJSON === 'function') {
    return dumps((object as { toJSON: () => unknown }).toJSON(), seen);
  }
  if (seen.has(object)) throw new TypeError('Circular reference detected');
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => dumps(item, seen) ?? 'null').join(', ')}]`;
    }
    const members: string[] = [];
    for (const [key, member] of Object.entries(object)) {
      const text = dumps(member, seen);
      if (text !== undefined) members.push(`${jsonString(key)}: ${text}`);
    }
    return `{${members.join(', ')}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * `json.dumps(value)` with Python's defaults: `", "` and `": "` separators,
 * `ensure_ascii=True`. Throws `TypeError` for what cannot be serialised, as
 * Python does.
 *
 * One difference that cannot be removed: JavaScript has a single number type,
 * so `3.0` is written `3` where Python would write `3.0`.
 */
export function pyJsonDumps(value: unknown): string {
  return dumps(value, new Set()) ?? 'null';
}

/** Python `repr(str)`. */
function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === '\\') out += '\\\\';
    else if (char === quote) out += `\\${quote}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += char;
  }
  return out + quote;
}

function repr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return reprString(value);
  if (typeof value === 'number') return pyNumber(value, false);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return `[${value.map(repr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, member]) => `${reprString(key)}: ${repr(member)}`)
      .join(', ')}}`;
  }
  return String(value);
}

/**
 * Python `str(value)` for the values a span wrapper stringifies: a string is
 * itself; a list or mapping is its `repr` (`['float']`, not `float`).
 */
export function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : repr(value);
}

/** Python `s[:n]`: the first `n` code points. A surrogate pair is never split. */
export function pyTruncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  let out = '';
  let count = 0;
  for (const char of value) {
    if (count >= maxLength) break;
    out += char;
    count += 1;
  }
  return out;
}
