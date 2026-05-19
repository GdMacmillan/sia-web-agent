import {
  describe,
  it,
  expect,
  beforeEach,
  jest,
  afterEach,
} from "@jest/globals";
import { LRUCache } from "../../../src/utils/lru-cache.js";

describe("LRUCache", () => {
  describe("Basic Operations", () => {
    let cache: LRUCache<string, string>;

    beforeEach(() => {
      cache = new LRUCache({ maxSize: 3 });
    });

    it("should store and retrieve values", () => {
      cache.set("key1", "value1");
      expect(cache.get("key1")).toBe("value1");
    });

    it("should return undefined for non-existent keys", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("should update existing keys", () => {
      cache.set("key1", "value1");
      cache.set("key1", "value2");
      expect(cache.get("key1")).toBe("value2");
      expect(cache.size).toBe(1);
    });

    it("should check key existence with has()", () => {
      cache.set("key1", "value1");
      expect(cache.has("key1")).toBe(true);
      expect(cache.has("nonexistent")).toBe(false);
    });

    it("should delete keys", () => {
      cache.set("key1", "value1");
      expect(cache.delete("key1")).toBe(true);
      expect(cache.has("key1")).toBe(false);
      expect(cache.delete("nonexistent")).toBe(false);
    });

    it("should clear the cache", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has("key1")).toBe(false);
    });

    it("should track cache size", () => {
      expect(cache.size).toBe(0);
      cache.set("key1", "value1");
      expect(cache.size).toBe(1);
      cache.set("key2", "value2");
      expect(cache.size).toBe(2);
    });
  });

  describe("LRU Eviction", () => {
    let cache: LRUCache<string, string>;

    beforeEach(() => {
      cache = new LRUCache({ maxSize: 3 });
    });

    it("should evict least recently used item when cache is full", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");

      // Cache is full, next set should evict key1 (least recently used)
      cache.set("key4", "value4");

      expect(cache.has("key1")).toBe(false);
      expect(cache.has("key2")).toBe(true);
      expect(cache.has("key3")).toBe(true);
      expect(cache.has("key4")).toBe(true);
      expect(cache.size).toBe(3);
    });

    it("should update LRU order on get()", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");

      // Access key1 to make it most recently used
      cache.get("key1");

      // Add key4, should evict key2 (now least recently used)
      cache.set("key4", "value4");

      expect(cache.has("key1")).toBe(true);
      expect(cache.has("key2")).toBe(false);
      expect(cache.has("key3")).toBe(true);
      expect(cache.has("key4")).toBe(true);
    });

    it("should update LRU order on set() for existing key", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");

      // Update key1 to make it most recently used
      cache.set("key1", "value1-updated");

      // Add key4, should evict key2 (now least recently used)
      cache.set("key4", "value4");

      expect(cache.get("key1")).toBe("value1-updated");
      expect(cache.has("key2")).toBe(false);
      expect(cache.has("key3")).toBe(true);
      expect(cache.has("key4")).toBe(true);
    });

    it("should not evict when cache is not full", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      const stats = cache.getStats();
      expect(stats.evictions).toBe(0);
    });
  });

  describe("TTL Expiration", () => {
    let cache: LRUCache<string, string>;

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should expire entries after TTL", () => {
      cache = new LRUCache({ maxSize: 10, ttlMs: 1000 });
      cache.set("key1", "value1");

      expect(cache.get("key1")).toBe("value1");

      // Advance time past TTL
      jest.advanceTimersByTime(1001);

      expect(cache.get("key1")).toBeUndefined();
      expect(cache.has("key1")).toBe(false);
    });

    it("should not expire entries before TTL", () => {
      cache = new LRUCache({ maxSize: 10, ttlMs: 1000 });
      cache.set("key1", "value1");

      // Advance time but not past TTL
      jest.advanceTimersByTime(999);

      expect(cache.get("key1")).toBe("value1");
    });

    it("should work without TTL when ttlMs is not provided", () => {
      cache = new LRUCache({ maxSize: 10 });
      cache.set("key1", "value1");

      // Advance time significantly
      jest.advanceTimersByTime(10000);

      expect(cache.get("key1")).toBe("value1");
    });

    it("should remove expired entry when checking has()", () => {
      cache = new LRUCache({ maxSize: 10, ttlMs: 1000 });
      cache.set("key1", "value1");

      jest.advanceTimersByTime(1001);

      expect(cache.has("key1")).toBe(false);
      // Entry should be removed from cache
      expect(cache.size).toBe(0);
    });
  });

  describe("Cache Statistics", () => {
    let cache: LRUCache<string, string>;

    beforeEach(() => {
      cache = new LRUCache({ maxSize: 3 });
    });

    it("should track hits and misses", () => {
      cache.set("key1", "value1");

      cache.get("key1"); // hit
      cache.get("key2"); // miss
      cache.get("key1"); // hit
      cache.get("key3"); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
    });

    it("should track evictions", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");
      cache.set("key4", "value4"); // evicts key1
      cache.set("key5", "value5"); // evicts key2

      const stats = cache.getStats();
      expect(stats.evictions).toBe(2);
    });

    it("should reset stats on clear()", () => {
      cache.set("key1", "value1");
      cache.get("key1");
      cache.get("key2");
      cache.set("key2", "value2");
      cache.set("key3", "value3");
      cache.set("key4", "value4");

      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.size).toBe(0);
    });

    it("should include maxSize in stats", () => {
      const stats = cache.getStats();
      expect(stats.maxSize).toBe(3);
    });
  });

  describe("Iteration", () => {
    let cache: LRUCache<string, number>;

    beforeEach(() => {
      cache = new LRUCache({ maxSize: 5 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
    });

    it("should iterate over keys in LRU order", () => {
      const keys = Array.from(cache.keys());
      expect(keys).toEqual(["a", "b", "c"]);
    });

    it("should iterate over values in LRU order", () => {
      const values = Array.from(cache.values());
      expect(values).toEqual([1, 2, 3]);
    });

    it("should skip expired entries when iterating values", () => {
      jest.useFakeTimers();
      const cacheWithTTL = new LRUCache<string, number>({
        maxSize: 5,
        ttlMs: 1000,
      });
      cacheWithTTL.set("a", 1);
      cacheWithTTL.set("b", 2);

      jest.advanceTimersByTime(1001);

      cacheWithTTL.set("c", 3); // Not expired

      const values = Array.from(cacheWithTTL.values());
      expect(values).toEqual([3]);

      jest.useRealTimers();
    });
  });

  describe("Type Safety", () => {
    it("should work with different key and value types", () => {
      interface User {
        id: number;
        name: string;
      }

      const cache = new LRUCache<number, User>({ maxSize: 10 });
      const user: User = { id: 1, name: "Alice" };

      cache.set(1, user);
      const retrieved = cache.get(1);

      expect(retrieved).toEqual(user);
      expect(retrieved?.name).toBe("Alice");
    });

    it("should work with complex key types", () => {
      const cache = new LRUCache<{ id: string }, string>({ maxSize: 10 });
      const key = { id: "abc123" };

      cache.set(key, "value");
      expect(cache.get(key)).toBe("value");
    });
  });
});
