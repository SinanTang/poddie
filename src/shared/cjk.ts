// CJK unified ideographs + extensions, kana, hangul, CJK symbols/punct, fullwidth forms
const CJK_RE = /[⺀-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/

const NO_SPACE_BEFORE = /^[,.!?;:%)\]}，。！？；：、）】》%'’”…-]/
const NO_SPACE_AFTER = /[([{（【《'‘“-]$/

export function isCjk(text: string): boolean {
  return CJK_RE.test(text)
}

/**
 * Whether a space belongs between two adjacent transcript tokens when joining
 * for display or search. CJK–CJK joins directly (中文 has no spaces); every
 * other pair gets a space (including the CJK–Latin boundary, per zh/en mixed
 * typesetting convention), except around attaching punctuation.
 */
export function needsSpaceBetween(prev: string, next: string): boolean {
  if (!prev || !next) return false
  if (NO_SPACE_BEFORE.test(next)) return false
  if (NO_SPACE_AFTER.test(prev)) return false
  return !(CJK_RE.test(prev[prev.length - 1]) && CJK_RE.test(next[0]))
}

/** Join transcript tokens into display text using the spacing rules above. */
export function joinTokens(tokens: string[]): string {
  let out = ''
  for (const token of tokens) {
    if (out && needsSpaceBetween(out, token)) out += ' '
    out += token
  }
  return out
}
