/**
 * Caps how many summary requests are in flight at once. A single spy handle can expose
 * 40+ accounts, and each summary fans out into several upstream Ads API calls, so letting
 * every card fetch at mount would stall the browser and burn rate limit for no benefit.
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  function release() {
    active -= 1;
    waiting.shift()?.();
  }

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
