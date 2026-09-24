/** Insertion-ordered LRU map. Entries for which `canEvict` returns false are never evicted. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly max: number;
  private readonly canEvict: (key: K, value: V) => boolean;

  constructor(max: number, canEvict: (key: K, value: V) => boolean = () => true) {
    this.max = max;
    this.canEvict = canEvict;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.evict();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  clear(): void {
    this.map.clear();
  }

  private evict(): void {
    if (this.map.size <= this.max) return;
    for (const [key, value] of this.map) {
      if (this.map.size <= this.max) break;
      if (this.canEvict(key, value)) this.map.delete(key);
    }
  }
}
