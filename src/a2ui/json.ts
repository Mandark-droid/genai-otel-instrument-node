/**
 * `json.dumps(value, sort_keys=True, ...)` as Python writes it, because A2UI and A2A content
 * attributes must read the same whichever SDK produced the span: keys sorted at every level,
 * non-ASCII escaped (`ensure_ascii`), and either Python's default separators (`", "`, `": "`)
 * or the compact ones (`","`, `":"`).
 *
 * One difference cannot be removed: JavaScript has one number type, so `3.0` is written `3`.
 * A value `default=str` would stringify (anything that is not JSON) is written as `String(value)`.
 */

function jsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const char = value[i] as string;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

function dumps(value: unknown, compact: boolean, seen: Set<object>): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return jsonString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
      return String(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) return jsonString('[circular]');
  seen.add(object);
  try {
    const itemSeparator = compact ? ',' : ', ';
    const keySeparator = compact ? ':' : ': ';
    if (Array.isArray(object)) return `[${object.map((item) => dumps(item, compact, seen) ?? 'null').join(itemSeparator)}]`;
    if (object instanceof Date || typeof (object as { toJSON?: unknown }).toJSON === 'function') {
      return dumps((object as { toJSON: () => unknown }).toJSON(), compact, seen);
    }
    const members: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const text = dumps((object as Record<string, unknown>)[key], compact, seen);
      if (text !== undefined) members.push(`${jsonString(key)}${keySeparator}${text}`);
    }
    return `{${members.join(itemSeparator)}}`;
  } finally {
    seen.delete(object);
  }
}

/** `json.dumps(value, default=str, sort_keys=True, separators=(",", ":"))` */
export function jsonCompactSorted(value: unknown): string {
  return dumps(value, true, new Set()) ?? 'null';
}

/** `json.dumps(value, default=str, sort_keys=True)` */
export function jsonSorted(value: unknown): string {
  return dumps(value, false, new Set()) ?? 'null';
}
