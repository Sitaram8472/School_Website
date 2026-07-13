const assert = require('assert');
const { LRUCache } = require('./cache');

async function runTests() {
  console.log("Running Cache Tests...");

  // Test 1: Set and Get
  let cache = new LRUCache(2);
  cache.set('a', 1);
  assert.strictEqual(cache.get('a'), 1, "Cache should return 1 for key 'a'");
  assert.strictEqual(cache.get('b'), null, "Cache should return null for missing key 'b'");

  // Test 2: LRU Eviction
  cache = new LRUCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // Should evict 'a'
  
  assert.strictEqual(cache.get('a'), null, "Cache should have evicted 'a'");
  assert.strictEqual(cache.get('b'), 2);
  assert.strictEqual(cache.get('c'), 3);

  // Test 3: LRU Refresh
  cache = new LRUCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // refresh 'a'
  cache.set('c', 3); // should evict 'b'

  assert.strictEqual(cache.get('b'), null, "Cache should have evicted 'b' instead of 'a'");
  assert.strictEqual(cache.get('a'), 1);
  assert.strictEqual(cache.get('c'), 3);

  // Test 4: TTL Expiration
  cache = new LRUCache(2);
  cache.set('a', 1, 0.1); // TTL 0.1s
  assert.strictEqual(cache.get('a'), 1);
  
  await new Promise(res => setTimeout(res, 200)); // wait 0.2s
  assert.strictEqual(cache.get('a'), null, "Cache should return null for expired key");

  // Test 5: Invalidate
  cache = new LRUCache(2);
  cache.set('a', 1);
  cache.invalidate('a');
  assert.strictEqual(cache.get('a'), null, "Cache should return null after invalidation");

  console.log("All cache tests passed successfully! ✅");
}

runTests().catch(err => {
  console.error("Test failed!", err);
  process.exit(1);
});
