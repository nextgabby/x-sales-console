/**
 * Which creative is actually the best, defined once.
 *
 * The server needs this to guarantee the winner is one of the creatives it enriches with text and a
 * preview, and the client needs it to place the badge. Two copies would drift, and the failure would
 * be a creative marked "Best CTR" with no text to show for it.
 */
import type { Totals } from "./stats";

/**
 * Delivery floors before a rate is worth comparing. Impressions alone are not enough: on a real
 * 187-creative campaign the CTR leader had 6,782 impressions and about 93 clicks, a rate that moves
 * on a handful of stray taps, while a creative with seven times the delivery sat just behind it.
 */
export const MIN_IMPRESSIONS_TO_RANK = 1_000;
export const MIN_CLICKS_TO_RANK = 100;

type Rankable = { id: string; totals: Totals };

export function isRankable(post: Rankable): boolean {
  return (
    post.totals.impressions >= MIN_IMPRESSIONS_TO_RANK &&
    post.totals.clicks >= MIN_CLICKS_TO_RANK
  );
}

/** The highest click-through rate among creatives with enough delivery to judge. */
export function bestByCtr<T extends Rankable>(posts: T[]): T | null {
  return posts
    .filter(isRankable)
    .reduce<T | null>(
      (best, post) => (!best || post.totals.ctr > best.totals.ctr ? post : best),
      null,
    );
}
