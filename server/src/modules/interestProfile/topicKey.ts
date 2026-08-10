/**
 * Normalization of topic phrases into match keys.
 *
 * Annotation returns whatever phrase the model chose, so "LLMs", "L.L.M.", and
 * "llm" arrive as three strings meaning one thing. Everything that resolves a
 * phrase — topic keys, aliases, candidate accumulation — goes through this one
 * function, because two normalizers that disagree by a hyphen produce two
 * topics for one interest and a coverage distribution that reads as breadth the
 * reader does not have.
 *
 * Deliberately conservative: case, punctuation, whitespace, and a trailing
 * plural `s`. It does not stem, because stemming merges "computing" with
 * "computer" and there is no way for the owner to see why two distinct
 * interests collapsed.
 */
export const MAX_TOPIC_KEY_LENGTH = 128;

export function topicKeyFor(phrase: string): string {
  const base = phrase
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!base) return "";
  const singular = base
    .split(" ")
    .map((word) => depluralize(word))
    .join(" ");
  return singular.replace(/\s+/g, "-").slice(0, MAX_TOPIC_KEY_LENGTH);
}

/**
 * Strips a plural `s` only where doing so is unambiguous.
 *
 * Asymmetric on purpose. Under-merging costs a split distribution, which
 * aliases can repair after the fact; over-merging silently fuses two unrelated
 * interests under one key, which the owner cannot undo without deleting a topic
 * and cannot even see, because nothing records that the merge happened.
 *
 * So a vowel before the `s` blocks stripping: `bias`, `corpus`, and `analysis`
 * are singular, and no rule tells them apart from genuine plurals like `ideas`
 * or `cameras` without a dictionary. Those plurals stay unmerged, and an alias
 * on the topic repairs them when they matter.
 */
function depluralize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ss")) return word;
  // Discipline names — robotics, physics, economics, politics, mathematics —
  // are singular, and they are among the most common shapes a topic phrase
  // takes. This also blocks "topics" → "topic", which is the trade accepted
  // above: a split distribution an alias can repair, rather than a silent merge.
  if (word.endsWith("ics")) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[aeiou]s$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}
