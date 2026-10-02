/**
 * Python `re` patterns, run by the JavaScript engine with Python's meaning.
 *
 * The detectors' patterns are Python string patterns. Three things differ:
 *
 * - `\w`, `\d`, `\s` and `\b` are Unicode-aware in Python and ASCII-only in
 *   JavaScript (with or without the `u` flag). They are rewritten to property
 *   classes and, for `\b`, to the lookaround that defines it.
 * - Python accepts an escaped ordinary character (`\%`, `\-` outside a class);
 *   the `u` flag does not.
 * - Python reports offsets in code points; JavaScript in UTF-16 units.
 *
 * What is not translated, and throws: a negated shorthand inside a character
 * class (`[^\W]`), conditional groups, and inline flags other than a leading
 * `(?i)`. None of the reference's patterns uses them.
 */

/** Python's `\s` for str patterns: `str.isspace()`. Usable inside a character class. */
export const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python's `\w`: alphanumeric (`str.isalnum()`) or underscore. Usable inside a character class. */
const PY_WORD = '\\p{L}\\p{N}_';
const PY_DIGIT = '\\p{Nd}';
/** `\b`: between a word character and a non-word character or an end. */
export const PY_WORD_BOUNDARY = `(?:(?<=[${PY_WORD}])(?![${PY_WORD}])|(?<![${PY_WORD}])(?=[${PY_WORD}]))`;
const PY_NOT_WORD_BOUNDARY = `(?:(?<=[${PY_WORD}])(?=[${PY_WORD}])|(?<![${PY_WORD}])(?![${PY_WORD}]))`;

/** Characters that may follow a backslash under the `u` flag. */
const SYNTAX = new Set('^$\\.*+?()[]{}|/');

/** Rewrite a Python pattern for `new RegExp(..., 'u')`. */
export function translatePattern(pattern: string): { source: string; ignoreCase: boolean } {
  let ignoreCase = false;
  let input = pattern;
  if (input.startsWith('(?i)')) {
    ignoreCase = true;
    input = input.slice(4);
  }
  let out = '';
  let inClass = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    if (char === '\\') {
      const next = input[i + 1];
      if (next === undefined) throw new SyntaxError(`pattern ends with a backslash: ${pattern}`);
      i += 1;
      switch (next) {
        case 'd':
          out += PY_DIGIT;
          continue;
        case 'w':
          out += inClass ? PY_WORD : `[${PY_WORD}]`;
          continue;
        case 's':
          out += inClass ? PY_SPACE : `[${PY_SPACE}]`;
          continue;
        case 'D':
          if (inClass) throw new SyntaxError(`\\D inside a character class is not supported: ${pattern}`);
          out += '\\P{Nd}';
          continue;
        case 'W':
          if (inClass) throw new SyntaxError(`\\W inside a character class is not supported: ${pattern}`);
          out += `[^${PY_WORD}]`;
          continue;
        case 'S':
          if (inClass) throw new SyntaxError(`\\S inside a character class is not supported: ${pattern}`);
          out += `[^${PY_SPACE}]`;
          continue;
        case 'b':
          // Inside a class Python's \b is a backspace.
          out += inClass ? '\\x08' : PY_WORD_BOUNDARY;
          continue;
        case 'B':
          if (inClass) throw new SyntaxError(`\\B inside a character class is not supported: ${pattern}`);
          out += PY_NOT_WORD_BOUNDARY;
          continue;
        case 'A':
          out += '(?<![\\s\\S])';
          continue;
        case 'Z':
          out += '(?![\\s\\S])';
          continue;
        default:
      }
      if (/[0-9nrtfvxuc]/.test(next)) {
        // Numeric, control and code-point escapes mean the same in both.
        out += `\\${next}`;
      } else if (next === 'a') {
        out += '\\x07';
      } else if (SYNTAX.has(next) || (next === '-' && inClass)) {
        out += `\\${next}`;
      } else if (next === '-') {
        out += '-';
      } else {
        // An escaped ordinary character is that character.
        out += next;
      }
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      out += char;
      continue;
    }
    if (char === '[') {
      inClass = true;
      out += char;
      // A `]` first in a class (after an optional `^`) is a literal in Python.
      if (input[i + 1] === '^') {
        out += '^';
        i += 1;
      }
      if (input[i + 1] === ']') {
        out += '\\]';
        i += 1;
      }
      continue;
    }
    if (char === '{') {
      // A brace that is not a repetition count is a literal in Python.
      const quantifier = /^\{(\d*)(,(\d*))?\}/.exec(input.slice(i));
      if (quantifier && (quantifier[1] !== '' || (quantifier[3] ?? '') !== '')) {
        out += quantifier[1] === '' ? `{0,${quantifier[3] as string}}` : quantifier[0];
        i += quantifier[0].length - 1;
      } else {
        out += '\\{';
      }
      continue;
    }
    if (char === '}') {
      out += '\\}';
      continue;
    }
    if (char === '.') {
      // Python's dot stops at a newline only.
      out += '[^\\n]';
      continue;
    }
    if (char === '(' && input[i + 1] === '?') {
      if (input.startsWith('(?P<', i)) {
        out += '(?<';
        i += 3;
        continue;
      }
      if (input.startsWith('(?P=', i)) {
        const end = input.indexOf(')', i);
        out += `\\k<${input.slice(i + 4, end)}>`;
        i = end;
        continue;
      }
      if (input.startsWith('(?(', i)) throw new SyntaxError(`conditional groups are not supported: ${pattern}`);
    }
    out += char;
  }
  return { source: out, ignoreCase };
}

const cache = new Map<string, RegExp>();

/** A compiled Python pattern. Global, so `matchAll` gives `re.finditer`'s non-overlapping matches. */
export function pyRegExp(pattern: string, ignoreCase = false): RegExp {
  const key = `${ignoreCase ? 'i' : '-'}${pattern}`;
  let compiled = cache.get(key);
  if (!compiled) {
    const translated = translatePattern(pattern);
    compiled = new RegExp(translated.source, `gu${ignoreCase || translated.ignoreCase ? 'i' : ''}`);
    cache.set(key, compiled);
  }
  return compiled;
}

export interface PyMatch {
  /** The whole match: `match.group()`. */
  text: string;
  /** Offsets in code points, end exclusive: `match.start()`, `match.end()`. */
  start: number;
  end: number;
  /** Capture groups, from 1: `match.groups()`. */
  groups: (string | undefined)[];
}

const codePoints = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

/** `re.finditer(pattern, text)`. */
export function findIter(pattern: string, text: string, ignoreCase = false): PyMatch[] {
  const matches: PyMatch[] = [];
  let unit = 0;
  let point = 0;
  for (const match of text.matchAll(pyRegExp(pattern, ignoreCase))) {
    const index = match.index ?? 0;
    point += codePoints(text.slice(unit, index));
    unit = index;
    matches.push({ text: match[0], start: point, end: point + codePoints(match[0]), groups: match.slice(1) });
  }
  return matches;
}

/** `re.search(pattern, text)`: the first match, anywhere. */
export function search(pattern: string, text: string, ignoreCase = false): PyMatch | undefined {
  const expression = pyRegExp(pattern, ignoreCase);
  expression.lastIndex = 0;
  const match = expression.exec(text);
  expression.lastIndex = 0;
  if (!match) return undefined;
  const start = codePoints(text.slice(0, match.index));
  return { text: match[0], start, end: start + codePoints(match[0]), groups: match.slice(1) };
}

/** `re.escape(text)`, for a pattern that goes through `translatePattern`. */
export function pyEscape(text: string): string {
  return text.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');
}

/** `text.split()`: on runs of whitespace, without empty strings. */
export function pySplit(text: string): string[] {
  return text.split(new RegExp(`[${PY_SPACE}]+`, 'u')).filter((part) => part !== '');
}

/** `text.strip()`. */
export function pyStrip(text: string): string {
  return text.replace(new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu'), '');
}

/** Slice by code points: `text[start:end]`. */
export function sliceCodePoints(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join('');
}
