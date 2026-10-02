/**
 * Python `re` patterns run with Python's meaning: Unicode-aware classes,
 * code-point offsets, and the escapes Python accepts and the `u` flag does not.
 * Expected values are what CPython 3 returns for the same call.
 */
import { describe, expect, it } from 'vitest';
import { findIter, pyEscape, pyRegExp, pySplit, pyStrip, search, sliceCodePoints, translatePattern } from '../../src/evaluation/pyre';

const texts = (pattern: string, text: string, ignoreCase = false): string[] => findIter(pattern, text, ignoreCase).map((match) => match.text);

describe('Unicode-aware classes', () => {
  it('\\d matches any decimal digit, not only ASCII', () => {
    // re.findall(r"\d+", "٣٤٥ and 12") == ['٣٤٥', '12']
    expect(texts('\\d+', '٣٤٥ and 12')).toEqual(['٣٤٥', '12']);
    expect(texts('\\D+', '12ab٣')).toEqual(['ab']);
  });

  it('\\w matches letters of any script', () => {
    expect(texts('\\w+', 'héllo wörld_1 привет')).toEqual(['héllo', 'wörld_1', 'привет']);
    expect(texts('\\W+', 'a, b')).toEqual([', ']);
    expect(texts('[\\w.]+', 'é.x y')).toEqual(['é.x', 'y']);
  });

  it('\\s is str.isspace(): the information separators and NEL count, the BOM does not', () => {
    expect(texts('a\\sb', 'a\u001cb a\u0085b a b a﻿b')).toEqual(['a\u001cb', 'a\u0085b', 'a b']);
    expect(texts('\\S+', ' ab cd ')).toEqual(['ab', 'cd']);
    expect(texts('[\\s,]+', 'a , b')).toEqual([' , ']);
  });

  it('\\b treats non-ASCII letters as word characters', () => {
    // re.findall(r"\bкот\b", "кот котик кот") == ['кот', 'кот']
    expect(texts('\\bкот\\b', 'кот котик кот')).toEqual(['кот', 'кот']);
    // In JavaScript, /\bé/ would match inside "café"; in Python it does not.
    expect(texts('\\bé', 'café était')).toEqual(['é']);
    expect(texts('\\Bat', 'cat at')).toEqual(['at']);
  });

  it('the dot stops at a newline only', () => {
    expect(texts('a.b', 'a\rb a\nb')).toEqual(['a\rb']);
  });
});

describe('offsets are code points', () => {
  it('an astral character before the match counts once', () => {
    // m = re.search(r"\d+", "😀😀 42"); (m.start(), m.end()) == (3, 5)
    const [match] = findIter('\\d+', '😀😀 42');
    expect(match).toMatchObject({ text: '42', start: 3, end: 5 });
    expect(search('\\d+', '😀😀 42')).toMatchObject({ start: 3, end: 5 });
  });

  it('successive matches accumulate correctly', () => {
    expect(findIter('x', '😀x😀x').map((match) => [match.start, match.end])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('groups are returned from 1', () => {
    expect(findIter('(\\w+)=(\\d+)', 'a=1 b=2').map((match) => match.groups)).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(search('(x)?y', 'y')?.groups).toEqual([undefined]);
    expect(search('z', 'y')).toBeUndefined();
  });

  it('search is repeatable on the cached expression', () => {
    expect(search('a', 'ba')?.start).toBe(1);
    expect(search('a', 'ba')?.start).toBe(1);
    expect(sliceCodePoints('a😀bc', 1, 3)).toBe('😀b');
    expect(sliceCodePoints('a😀bc', 2)).toBe('bc');
  });
});

describe('escapes Python accepts', () => {
  it('an escaped ordinary character is that character', () => {
    expect(texts('100\\%', 'at 100%')).toEqual(['100%']);
    expect(texts('a\\-b', 'a-b')).toEqual(['a-b']);
    expect(texts('[a\\-c]+', 'a-c b')).toEqual(['a-c']);
    expect(texts('\\x41\\t\\u00e9', 'A\té')).toEqual(['A\té']);
    expect(texts('\\a', '\u0007')).toEqual(['\u0007']);
    expect(texts('[\\b]', 'a\bb')).toEqual(['\b']);
    expect(texts('\\\\x[0-9a-f]{2}', 'see \\x4f')).toEqual(['\\x4f']);
  });

  it('a brace that is not a repetition count is a literal', () => {
    expect(texts('\\{[0-9]+\\}', 'Hello {0}')).toEqual(['{0}']);
    expect(texts('a{b}', 'a{b}')).toEqual(['a{b}']);
    expect(texts('a{2,}', 'a aaa')).toEqual(['aaa']);
    expect(texts('a{2}', 'aaa')).toEqual(['aa']);
    // Python reads {,2} as {0,2}.
    expect(texts('ba{,2}', 'baaa')).toEqual(['baa']);
    expect(texts('x{}', 'x{}')).toEqual(['x{}']);
  });

  it('a ] first in a class is a literal', () => {
    expect(texts('[]a]+', 'a]b')).toEqual(['a]']);
    expect(texts('[^]a]+', 'a]bc')).toEqual(['bc']);
    expect(texts('[^a]+', 'abc')).toEqual(['bc']);
  });

  it('\\A and \\Z anchor the whole text', () => {
    expect(texts('\\Aab', 'ab ab')).toEqual(['ab']);
    expect(texts('ab\\Z', 'ab ab')).toEqual(['ab']);
  });

  it('named groups and a leading (?i)', () => {
    expect(texts('(?P<q>["\']).*?(?P=q)', 'say "hi" now')).toEqual(['"hi"']);
    expect(translatePattern('(?i)abc')).toEqual({ source: 'abc', ignoreCase: true });
    expect(texts('(?i)abc', 'ABC')).toEqual(['ABC']);
    expect(texts('abc', 'ABC', true)).toEqual(['ABC']);
    expect(texts('abc', 'ABC')).toEqual([]);
  });
});

describe('what is not supported says so', () => {
  it.each([
    ['[\\D]', 'inside a character class'],
    ['[\\W]', 'inside a character class'],
    ['[\\S]', 'inside a character class'],
    ['[\\B]', 'inside a character class'],
    ['(?(1)a|b)', 'conditional groups'],
    ['abc\\', 'ends with a backslash'],
  ])('%s', (pattern, message) => {
    expect(() => translatePattern(pattern)).toThrow(message);
  });
});

describe('helpers', () => {
  it('pyEscape makes any text a literal pattern', () => {
    const text = 'a.b*c+d?e(f)[g]{h}|i^j$k\\l/m-n %';
    expect(texts(pyEscape(text), `x ${text} y`)).toEqual([text]);
  });

  it('pySplit and pyStrip follow str.split() and str.strip()', () => {
    expect(pySplit('  a\tb c\n')).toEqual(['a', 'b', 'c']);
    expect(pySplit('   ')).toEqual([]);
    expect(pyStrip('\n  a b  ')).toEqual('a b');
  });

  it('a compiled pattern is global and Unicode', () => {
    expect(pyRegExp('a').flags).toBe('gu');
    expect(pyRegExp('a', true).flags).toBe('giu');
    expect(pyRegExp('a')).toBe(pyRegExp('a'));
  });
});
