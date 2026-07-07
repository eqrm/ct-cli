/**
 * Run an async mapper over `items` with at most `concurrency` in flight at once.
 * Results preserve input order. Errors from `fn` propagate — callers that want
 * partial-failure tolerance should catch inside `fn` and return a sentinel.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));

  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
