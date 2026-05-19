/**
 * Generic LRU (Least Recently Used) Cache with TTL support
 *
 * Features:
 * - O(1) get/set operations using Map ordering (insertion order preservation)
 * - Configurable maximum size with automatic eviction
 * - Optional TTL (time-to-live) for cache entries
 * - TypeScript generics for type safety
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number | null;
}

export interface LRUCacheOptions {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Time-to-live in milliseconds (optional) */
  ttlMs?: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  evictions: number;
}

export class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private readonly maxSize: number;
  private readonly ttlMs: number | null;
  private hits: number = 0;
  private misses: number = 0;
  private evictions: number = 0;

  constructor(options: LRUCacheOptions) {
    this.cache = new Map();
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs ?? null;
  }

  /**
   * Get a value from the cache
   * Returns undefined if key doesn't exist or entry has expired
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL expiration
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to end (most recently used) by deleting and re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;

    return entry.value;
  }

  /**
   * Set a value in the cache
   * Automatically evicts the least recently used entry if cache is full
   */
  set(key: K, value: V): void {
    // If key exists, delete it first so we can re-insert at the end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry in Map)
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
      this.evictions++;
    }

    const expiresAt = this.ttlMs !== null ? Date.now() + this.ttlMs : null;
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Check if a key exists in the cache (without updating LRU order)
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    // Check TTL expiration
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific entry from the cache
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Get the current size of the cache
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics for debugging and monitoring
   */
  getStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /**
   * Get all keys in the cache (in LRU order: oldest first, newest last)
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * Get all values in the cache (in LRU order: oldest first, newest last)
   */
  values(): IterableIterator<V> {
    const values: V[] = [];
    for (const entry of this.cache.values()) {
      // Skip expired entries
      if (entry.expiresAt === null || Date.now() <= entry.expiresAt) {
        values.push(entry.value);
      }
    }
    return values[Symbol.iterator]();
  }
}
