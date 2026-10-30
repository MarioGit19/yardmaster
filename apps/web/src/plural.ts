const rules = new Intl.PluralRules('en');

/** The form of a word that goes with `count`: `plural(1, 'error')` → "error". */
export const plural = (count: number, one: string, other = `${one}s`) =>
  rules.select(count) === 'one' ? one : other;

/** `count` with its word: `countOf(1, 'error')` → "1 error", `countOf(2, 'error')` → "2 errors". */
export const countOf = (count: number, one: string, other?: string) =>
  `${count} ${plural(count, one, other)}`;
