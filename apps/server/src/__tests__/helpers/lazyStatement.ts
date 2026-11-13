/**
 * A raw statement the way Prisma builds one: lazy. A PrismaPromise sends
 * nothing until it is awaited (or run in a batch), so a mock that records a
 * statement when it is BUILT cannot tell a statement that runs from one that
 * is built and never awaited. This records `name` in `ran` when the
 * statement is first awaited, and resolves with `result`.
 */
export function lazyStatement<T>(ran: string[], name: string, result: T): PromiseLike<T> {
  let running: Promise<T> | undefined;
  return {
    then(onFulfilled, onRejected) {
      if (!running) {
        ran.push(name);
        running = Promise.resolve(result);
      }
      return running.then(onFulfilled, onRejected);
    },
  };
}

/** Runs a batch of lazy statements the way `$transaction([...])` does: each in turn. */
export async function runBatch(statements: unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const statement of statements) results.push(await statement);
  return results;
}
