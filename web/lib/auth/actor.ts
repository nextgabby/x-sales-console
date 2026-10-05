/**
 * Who an Ads API call is being made on behalf of.
 *
 * Carried through every data-fetching function instead of the bare handle it replaced. On a shared
 * deployment the handle alone is not an identity: people rename themselves, two reps can hold the
 * same display name, and a handle in an audit row cannot be joined back to the record whose token
 * actually signed the request. The numeric user id can, and it is what X itself considers stable.
 *
 * Both fields are nullable because one caller legitimately has neither: the demo, where no real
 * identity exists and no audit row is written at all.
 */
export type Actor = {
  userId: string | null;
  handle: string | null;
};

export const ANONYMOUS_ACTOR: Actor = { userId: null, handle: null };
