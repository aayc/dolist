/** Runs async critical sections one at a time, in call order. A failed section doesn't poison the queue. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** True while a section is running or queued. */
  get busy(): boolean {
    return this.pending > 0;
  }

  run<T>(section: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(section, section);
    this.tail = result.then(
      () => this.pending--,
      () => this.pending--,
    );
    return result;
  }
}
