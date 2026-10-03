/**
 * BERT's tokenizer as Detoxify-style models expect it: Hugging Face's
 * `BasicTokenizer` (control characters dropped, whitespace normalised, CJK
 * characters split out, optional lower-casing with accents stripped,
 * punctuation split) then greedy longest-match WordPiece over `vocab.txt`,
 * wrapped in `[CLS]` ... `[SEP]`. Checked against `BertTokenizer` (transformers 5).
 */

const MAX_CHARS_PER_WORD = 100;

/** `\t`, `\n`, `\r` and the space separators (Zs). */
const isWhitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r' || /\p{Zs}/u.test(char);

/** Every "C*" category except `\t`, `\n`, `\r`, which count as whitespace. */
const isControl = (char: string): boolean => char !== '\t' && char !== '\n' && char !== '\r' && /\p{C}/u.test(char);

/** BERT's definition: the ASCII non-alphanumeric symbols, and every Unicode punctuation category. */
function isPunctuation(char: string): boolean {
  const cp = char.codePointAt(0) as number;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(char);
}

/** The CJK Unified Ideographs blocks, as BERT defines them. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

export class BertWordPiece {
  private readonly unknown: number;
  private readonly classify: number;
  private readonly separator: number;

  private constructor(
    private readonly vocabulary: ReadonlyMap<string, number>,
    private readonly lowerCase: boolean,
  ) {
    this.unknown = vocabulary.get('[UNK]') ?? 0;
    this.classify = vocabulary.get('[CLS]') ?? 0;
    this.separator = vocabulary.get('[SEP]') ?? 0;
  }

  /** One token per line, as `vocab.txt` holds them; a token's id is its line number. */
  static fromVocabulary(lines: readonly string[], lowerCase = true): BertWordPiece {
    const vocabulary = new Map<string, number>();
    lines.forEach((line, id) => vocabulary.set(line.replace(/[\r\n]+$/, ''), id));
    return new BertWordPiece(vocabulary, lowerCase);
  }

  /** The text of a `vocab.txt` file. */
  static fromVocabularyText(text: string, lowerCase = true): BertWordPiece {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return BertWordPiece.fromVocabulary(lines, lowerCase);
  }

  /** Token ids with `[CLS]` and `[SEP]`, at most `maxTokens` in all. */
  encode(text: string, maxTokens = 512): number[] {
    const room = Math.max(0, maxTokens - 2);
    const ids = [this.classify];
    outer: for (const word of this.basicTokens(text)) {
      for (const piece of this.wordPieces(word)) {
        if (ids.length - 1 >= room) break outer;
        ids.push(piece);
      }
    }
    ids.push(this.separator);
    return ids;
  }

  private basicTokens(text: string): string[] {
    let cleaned = '';
    for (const char of text) {
      const cp = char.codePointAt(0) as number;
      if (cp === 0 || cp === 0xfffd || isControl(char)) continue;
      if (isWhitespace(char)) cleaned += ' ';
      else if (isCjk(cp)) cleaned += ` ${char} `;
      else cleaned += char;
    }
    const tokens: string[] = [];
    for (let word of cleaned.normalize('NFC').split(' ')) {
      if (!word) continue;
      if (this.lowerCase) word = word.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
      let current = '';
      for (const char of word) {
        if (isPunctuation(char)) {
          if (current) tokens.push(current);
          current = '';
          tokens.push(char);
        } else {
          current += char;
        }
      }
      if (current) tokens.push(current);
    }
    return tokens;
  }

  private wordPieces(word: string): number[] {
    const chars = [...word];
    if (chars.length > MAX_CHARS_PER_WORD) return [this.unknown];
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const candidate = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        found = this.vocabulary.get(candidate);
        if (found !== undefined) break;
        end -= 1;
      }
      if (found === undefined) return [this.unknown];
      pieces.push(found);
      start = end;
    }
    return pieces;
  }
}
