export type Unsubscribe = () => void;

type Listener<T> = (payload: T) => void;

/** Listeners of one kind of change. One that throws never keeps the others from hearing it. */
export class Listeners<T = void> {
  readonly #set = new Set<Listener<T>>();
  readonly #onError: ((error: unknown) => void) | undefined;

  constructor(onError?: (error: unknown) => void) {
    this.#onError = onError;
  }

  get size(): number {
    return this.#set.size;
  }

  add(listener: Listener<T>): Unsubscribe {
    this.#set.add(listener);
    return () => {
      this.#set.delete(listener);
    };
  }

  emit(payload: T): void {
    for (const listener of [...this.#set]) {
      try {
        listener(payload);
      } catch (error) {
        this.#onError?.(error);
      }
    }
  }

  clear(): void {
    this.#set.clear();
  }
}

/** Tiny typed event emitter. Listener errors are isolated so one bad subscriber can't break others. */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
