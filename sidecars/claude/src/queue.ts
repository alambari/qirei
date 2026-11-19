/** An unbounded async queue: `push` from one side, `for await` on the other, `close` to end it. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly takers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): boolean {
    if (this.closed) return false;
    const take = this.takers.shift();
    if (take) take({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const take of this.takers.splice(0)) take({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.takers.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
