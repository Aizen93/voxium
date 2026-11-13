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

/**
 * `shape` (the sentinel a batch assertion compares) made a lazy statement
 * too: it records `name` in `ran` when it is awaited or run in a batch. The
 * `then` it gains is not enumerable, so `toEqual` still compares the shape
 * alone.
 */
export function lazySentinel<T extends object>(ran: string[], name: string, shape: T, result: unknown = []): T {
  Object.defineProperty(shape, 'then', { value: lazyStatement(ran, name, result).then, enumerable: false });
  return shape;
}

/** Runs a batch of lazy statements the way `$transaction([...])` does: each in turn. */
export async function runBatch(statements: unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const statement of statements) results.push(await statement);
  return results;
}
