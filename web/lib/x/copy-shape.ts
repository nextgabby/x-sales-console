/**
 * Measured attributes of ad copy.
 *
 * Extracted so the creative prompt and the setup checklist cannot disagree about what counts as a
 * hashtag. Both need the same facts for different reasons: the prompt cites them when explaining
 * why one creative beat another, and the checklist tests them against the Beautiful Ads playbook.
 *
 * Everything here is a count, never a judgement. Whether 3 hashtags is too many is the checklist's
 * opinion to hold, not this module's.
 */
export type CopyMeasure = {
  /** Characters with URLs removed, so a t.co link does not read as 23 characters of copy. */
  characters: number;
  words: number;
  lines: number;
  links: number;
  hashtags: number;
  mentions: number;
  emoji: number;
  /** Words of three letters or more in full caps, which is the shouting the playbook warns about. */
  capsWords: number;
  hasQuestion: boolean;
  hasExclamation: boolean;
  hasNumber: boolean;
  /** A currency amount or a percentage off — what the playbook calls a price or discount. */
  hasPrice: boolean;
};

export function measureCopy(text: string): CopyMeasure {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ").trim();
  const words = withoutUrls.split(/\s+/).filter(Boolean);
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;

  return {
    characters: withoutUrls.length,
    words: words.length,
    lines: withoutUrls.split("\n").filter((line) => line.trim()).length,
    links: count(/https?:\/\/\S+/g),
    hashtags: count(/#\w+/g),
    mentions: count(/@\w+/g),
    emoji: count(/\p{Extended_Pictographic}/gu),
    capsWords: words.filter(
      (word) => word.length > 2 && word === word.toUpperCase() && /[A-Z]/.test(word),
    ).length,
    hasQuestion: /\?/.test(withoutUrls),
    hasExclamation: /!/.test(withoutUrls),
    hasNumber: /\d/.test(withoutUrls),
    /**
     * A number alone is not a price — "3 reasons" is not a discount — so this wants a currency
     * symbol, a written amount, or an explicit percentage off.
     */
    hasPrice:
      /[$£€]\s?\d/.test(withoutUrls) ||
      /\d+\s?%\s?(off|discount)/i.test(withoutUrls) ||
      /\b\d+(\.\d+)?\s?(usd|dollars?|eur|gbp)\b/i.test(withoutUrls),
  };
}

/** The same measurements as a phrase, for the creative prompt. */
export function describeCopy(text: string): string {
  const m = measureCopy(text);
  const parts = [`${m.characters} characters`, `${m.words} words`];
  if (m.lines > 1) parts.push(`${m.lines} lines`);
  if (m.links) parts.push(`${m.links} link${m.links > 1 ? "s" : ""}`);
  else parts.push("no link");
  if (m.hashtags) parts.push(`${m.hashtags} hashtag${m.hashtags > 1 ? "s" : ""}`);
  if (m.mentions) parts.push(`${m.mentions} mention${m.mentions > 1 ? "s" : ""}`);
  if (m.emoji) parts.push(`${m.emoji} emoji`);
  if (m.capsWords) parts.push(`${m.capsWords} all-caps word${m.capsWords > 1 ? "s" : ""}`);
  if (m.hasQuestion) parts.push("asks a question");
  if (m.hasExclamation) parts.push("uses an exclamation");
  if (m.hasNumber) parts.push("contains a number");
  return parts.join(", ");
}
