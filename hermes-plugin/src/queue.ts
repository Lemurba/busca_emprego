type Task<T> = { group: string; run: () => Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

/** In-process bounded queue. Use a durable store adapter before horizontal scaling. */
export class LimitedTaskQueue {
  readonly #pending: Task<unknown>[] = [];
  readonly #activeByGroup = new Map<string, number>();
  #active = 0;

  constructor(readonly concurrency: number, readonly perGroup = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("INVALID_CONCURRENCY");
    if (!Number.isInteger(perGroup) || perGroup < 1) throw new Error("INVALID_GROUP_CONCURRENCY");
  }

  add<T>(group: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({ group, run, resolve: resolve as (value: unknown) => void, reject });
      this.#drain();
    });
  }

  get counts() { return { active: this.#active, pending: this.#pending.length }; }

  #drain(): void {
    while (this.#active < this.concurrency) {
      const index = this.#pending.findIndex((task) => (this.#activeByGroup.get(task.group) ?? 0) < this.perGroup);
      if (index < 0) return;
      const [task] = this.#pending.splice(index, 1);
      this.#active++;
      this.#activeByGroup.set(task.group, (this.#activeByGroup.get(task.group) ?? 0) + 1);
      void task.run().then(task.resolve, task.reject).finally(() => {
        this.#active--;
        const remaining = (this.#activeByGroup.get(task.group) ?? 1) - 1;
        if (remaining === 0) this.#activeByGroup.delete(task.group); else this.#activeByGroup.set(task.group, remaining);
        this.#drain();
      });
    }
  }
}
