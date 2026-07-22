const Redis = require('ioredis');

// L1 Memory Cache (Fastest)
const memoryCache = new Map();

// L2 Redis Cache
let redisClient = null;
try {
  redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  redisClient.on('error', (err) => {
    console.error('Redis connection error:', err.message);
  });
} catch (error) {
  console.error('Failed to initialize Redis:', error);
}

/**
 * Multi-Level Cache Middleware
 * Checks L1 (Memory) -> L2 (Redis) before hitting the database.
 * @param {number} ttl - Time to live in seconds (default: 60s)
 */
const multiLevelCache = (ttl = 60) => async (req, res, next) => {
  // Only cache GET requests
  if (req.method !== 'GET') {
    return next();
  }

  // Generate a unique cache key based on the URL and optionally the user role if needed
  const cacheKey = `cache:${req.originalUrl || req.url}`;
  const now = Date.now();

  try {
    // 1. Check L1 Memory Cache
    const l1Entry = memoryCache.get(cacheKey);
    if (l1Entry && l1Entry.expiresAt > now) {
      return res.status(200).json(l1Entry.data);
    } else if (l1Entry) {
      memoryCache.delete(cacheKey); // Expired
    }

    // 2. Check L2 Redis Cache
    if (redisClient && redisClient.status === 'ready') {
      const l2DataRaw = await redisClient.get(cacheKey);
      if (l2DataRaw) {
        const data = JSON.parse(l2DataRaw);
        // Backfill L1
        memoryCache.set(cacheKey, {
          data,
          expiresAt: now + (ttl * 1000)
        });
        return res.status(200).json(data);
      }
    }
  } catch (error) {
    console.warn('Cache read error (bypassing cache):', error.message);
  }

  // 3. Cache Miss - Intercept Response
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const expiresAt = Date.now() + (ttl * 1000);
      
      // Populate L1 Cache
      memoryCache.set(cacheKey, { data: body, expiresAt });

      // Populate L2 Cache
      if (redisClient && redisClient.status === 'ready') {
        redisClient.setex(cacheKey, ttl, JSON.stringify(body)).catch(e => {
          console.warn('Redis write error:', e.message);
        });
      }
    } catch (error) {
      console.warn('Cache write error:', error.message);
    }

    // Send the response
    return originalJson(body);
  };

  next();
};

module.exports = multiLevelCache;
