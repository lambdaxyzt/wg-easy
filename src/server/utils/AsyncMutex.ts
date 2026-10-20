/**
 * Runs async functions one at a time, in call order.
 *
 * Not reentrant: calling `run` from inside a running function deadlocks.
 */
export class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}
