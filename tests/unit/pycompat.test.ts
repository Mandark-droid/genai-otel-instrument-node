/**
 * Expected values were produced by running Python 3.12 (`json.dumps(x)` and
 * `str(x)`) on the same inputs; see the comment on each block.
 */
import { describe, expect, it } from 'vitest';
import { pyJsonDumps, pyStr, pyTruncate } from '../../src/pycompat';

describe('pyJsonDumps (json.dumps with default arguments)', () => {
  it('uses ", " and ": " separators and escapes every non-ASCII character', () => {
    expect(pyJsonDumps({ role: 'user', content: 'héllo "q" \n tab\t 😀 </tag>' })).toBe(
      '{"role": "user", "content": "h\\u00e9llo \\"q\\" \\n tab\\t \\ud83d\\ude00 </tag>"}',
    );
  });

  it('serialises a tool definition list', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ];
    expect(pyJsonDumps(tools)).toBe(
      '[{"type": "function", "function": {"name": "get_weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]',
    );
  });

  it('scalars, empty containers, nesting and control characters', () => {
    expect(pyJsonDumps({ a: 1, b: 1.5, c: true, d: null, e: [1, 2, [3]], f: {}, g: [], l: ' \x7f\x00' })).toBe(
      '{"a": 1, "b": 1.5, "c": true, "d": null, "e": [1, 2, [3]], "f": {}, "g": [], "l": "\\u2028\\u007f\\u0000"}',
    );
    expect(pyJsonDumps('plain')).toBe('"plain"');
    expect(pyJsonDumps('\b\f\r\\')).toBe('"\\b\\f\\r\\\\"');
  });

  it('floats use the Python exponent form', () => {
    expect(pyJsonDumps([1e21, 1e-7, 2.5e-10])).toBe('[1e+21, 1e-07, 2.5e-10]');
  });

  it('undefined members are dropped as JSON.stringify drops them; undefined in a list is null', () => {
    expect(pyJsonDumps({ a: undefined, b: 1 })).toBe('{"b": 1}');
    expect(pyJsonDumps([undefined, 1])).toBe('[null, 1]');
  });

  it('honours toJSON', () => {
    expect(pyJsonDumps({ when: new Date(Date.UTC(2026, 0, 2)) })).toBe('{"when": "2026-01-02T00:00:00.000Z"}');
  });

  it('refuses what Python refuses: non-finite numbers are not valid JSON, and cycles', () => {
    expect(() => pyJsonDumps(Number.NaN)).not.toThrow();
    expect(pyJsonDumps([Number.NaN, Infinity, -Infinity])).toBe('[NaN, Infinity, -Infinity]');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => pyJsonDumps(cyclic)).toThrow(/Circular/);
    expect(() => pyJsonDumps({ f: () => 1 })).toThrow(TypeError);
    expect(() => pyJsonDumps(10n)).toThrow(TypeError);
  });
});

describe('pyStr (str() of a value used as a span attribute)', () => {
  it.each([
    [['float'], "['float']"],
    [['a', 'b'], "['a', 'b']"],
    [[1, 2.5, true, null], '[1, 2.5, True, None]'],
    [["it's"], '["it\'s"]'],
    [['say "hi"'], '[\'say "hi"\']'],
    [['both \' and "'], '[\'both \\\' and "\']'],
    [{ k: 'v', n: [1] }, "{'k': 'v', 'n': [1]}"],
    [[1e21, 1e-7], '[1e+21, 1e-07]'],
    ['s', 's'],
    [['new\nline', 'tab\t', 'back\\slash', 'é', '\x00'], "['new\\nline', 'tab\\t', 'back\\\\slash', 'é', '\\x00']"],
    [null, 'None'],
    [undefined, 'None'],
    [true, 'True'],
    [false, 'False'],
    [42, '42'],
    [[], '[]'],
    [{}, '{}'],
  ])('%j -> %s', (value, expected) => {
    expect(pyStr(value)).toBe(expected);
  });
});

describe('pyTruncate (s[:n] counts code points)', () => {
  it('cuts by code point, never through a surrogate pair', () => {
    expect(pyTruncate('abcdef', 3)).toBe('abc');
    expect(pyTruncate('a😀b😀c', 2)).toBe('a😀');
    expect(pyTruncate('a😀b😀c', 4)).toBe('a😀b😀');
    expect(pyTruncate('short', 100)).toBe('short');
    expect(pyTruncate('x', 0)).toBe('');
  });
});
