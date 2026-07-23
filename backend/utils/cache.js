/**
 * Generic Caching Interface
 */
class CacheInterface {
  get(key) { throw new Error('Not implemented'); }
  set(key, value, ttl) { throw new Error('Not implemented'); }
  invalidate(key) { throw new Error('Not implemented'); }
}

/**
 * In-Memory LRU Cache Implementation
 */
class LRUCache extends CacheInterface {
  constructor(capacity = 100) {
    super();
    this.capacity = capacity;
    this.cache = new Map(); // Map preserves insertion order, so we can track LRU
  }

  get(key) {
    if (!this.cache.has(key)) return null;

    const item = this.cache.get(key);
    
    // Check TTL
    if (item.expiry && Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }

    // Refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, item);
    
    return item.value;
  }

  set(key, value, ttlSeconds = null) {
    // If it exists, delete it so we can push it to the end (most recently used)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if capacity reached
    else if (this.cache.size >= this.capacity) {
      // The Map iterator returns elements in insertion order (oldest first)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const expiry = ttlSeconds ? Date.now() + (ttlSeconds * 1000) : null;
    this.cache.set(key, { value, expiry });
  }

  invalidate(key) {
    this.cache.delete(key);
  }
}

// Export a singleton instance for general application use
const memoryCache = new LRUCache(200);

module.exports = {
  CacheInterface,
  LRUCache,
  memoryCache
};
