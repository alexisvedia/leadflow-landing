/**
 * Production-ready rate limiter with Redis support
 * Falls back to in-memory if Redis is not configured
 */

import { checkRateLimit as checkMemoryRateLimit, type RateLimitConfig, type RateLimitResult } from './rate-limiter';

// Redis client singleton (lazy loaded)
let redisClient: any = null;
let redisAvailable = false;
let redisChecked = false;

async function getRedisClient() {
  if (redisChecked) {
    return redisAvailable ? redisClient : null;
  }

  redisChecked = true;
  const redisUrl = import.meta.env.REDIS_URL || import.meta.env.UPSTASH_REDIS_REST_URL;

  if (!redisUrl) {
    console.log('[RateLimiter] No Redis URL configured, using in-memory store');
    return null;
  }

  try {
    // Try Upstash Redis (REST API - works in serverless)
    if (import.meta.env.UPSTASH_REDIS_REST_URL) {
      const { Redis } = await import('@upstash/redis');
      redisClient = new Redis({
        url: import.meta.env.UPSTASH_REDIS_REST_URL,
        token: import.meta.env.UPSTASH_REDIS_REST_TOKEN,
      });
      redisAvailable = true;
      console.log('[RateLimiter] Using Upstash Redis');
      return redisClient;
    }

    // Try standard Redis
    const { createClient } = await import('redis');
    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
    redisAvailable = true;
    console.log('[RateLimiter] Using Redis');
    return redisClient;
  } catch (error) {
    console.warn('[RateLimiter] Redis connection failed, falling back to memory:', error);
    redisAvailable = false;
    return null;
  }
}

/**
 * Check rate limit using Redis if available, otherwise in-memory
 */
export async function checkRateLimitAsync(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const redis = await getRedisClient();

  // Fall back to memory if Redis not available
  if (!redis) {
    return checkMemoryRateLimit(identifier, config);
  }

  const key = `ratelimit:${config.keyPrefix || 'rl'}:${identifier}`;
  const now = Date.now();
  const windowMs = config.windowMs;

  try {
    // Use Upstash Redis API
    if (import.meta.env.UPSTASH_REDIS_REST_URL) {
      return await checkUpstashRateLimit(redis, key, config, now);
    }

    // Use standard Redis
    return await checkStandardRedisRateLimit(redis, key, config, now);
  } catch (error) {
    console.error('[RateLimiter] Redis error, falling back to memory:', error);
    return checkMemoryRateLimit(identifier, config);
  }
}

async function checkUpstashRateLimit(
  redis: any,
  key: string,
  config: RateLimitConfig,
  now: number
): Promise<RateLimitResult> {
  // Get current count
  const data = await redis.get(key);
  const resetTime = now + config.windowMs;

  if (!data) {
    // First request in window
    await redis.set(key, JSON.stringify({ count: 1, resetTime }), {
      px: config.windowMs,
    });

    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetTime,
    };
  }

  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const count = parsed.count || 0;

  if (count >= config.maxRequests) {
    const retryAfter = Math.ceil((parsed.resetTime - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetTime: parsed.resetTime,
      retryAfter: retryAfter > 0 ? retryAfter : 1,
    };
  }

  // Increment count
  await redis.set(key, JSON.stringify({ count: count + 1, resetTime: parsed.resetTime }), {
    px: Math.max(parsed.resetTime - now, 1000),
  });

  return {
    allowed: true,
    remaining: config.maxRequests - count - 1,
    resetTime: parsed.resetTime,
  };
}

async function checkStandardRedisRateLimit(
  redis: any,
  key: string,
  config: RateLimitConfig,
  now: number
): Promise<RateLimitResult> {
  // Use Redis MULTI for atomic operations
  const multi = redis.multi();
  multi.incr(key);
  multi.pTTL(key);

  const results = await multi.exec();
  const count = results[0];
  const ttl = results[1];

  // First request - set expiry
  if (ttl === -1) {
    await redis.pExpire(key, config.windowMs);
  }

  const resetTime = now + (ttl > 0 ? ttl : config.windowMs);

  if (count > config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime,
      retryAfter: Math.ceil((ttl > 0 ? ttl : config.windowMs) / 1000),
    };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - count,
    resetTime,
  };
}

/**
 * Sliding window rate limiter for more accurate limiting
 * Uses Redis sorted sets
 */
export async function checkSlidingWindowRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const redis = await getRedisClient();

  if (!redis || !import.meta.env.UPSTASH_REDIS_REST_URL) {
    // Sliding window requires Redis - fall back to fixed window
    return checkRateLimitAsync(identifier, config);
  }

  const key = `ratelimit:sw:${config.keyPrefix || 'rl'}:${identifier}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  try {
    // Remove old entries
    await redis.zremrangebyscore(key, 0, windowStart);

    // Count current entries
    const count = await redis.zcard(key);

    if (count >= config.maxRequests) {
      // Get oldest entry to calculate retry time
      const oldest = await redis.zrange(key, 0, 0, { withScores: true });
      const oldestTime = oldest?.[0]?.score || now;
      const retryAfter = Math.ceil((oldestTime + config.windowMs - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetTime: oldestTime + config.windowMs,
        retryAfter: retryAfter > 0 ? retryAfter : 1,
      };
    }

    // Add new entry
    await redis.zadd(key, { score: now, member: `${now}:${Math.random()}` });
    await redis.pexpire(key, config.windowMs);

    return {
      allowed: true,
      remaining: config.maxRequests - count - 1,
      resetTime: now + config.windowMs,
    };
  } catch (error) {
    console.error('[RateLimiter] Sliding window error:', error);
    return checkRateLimitAsync(identifier, config);
  }
}

// Re-export helpers and configs
export { rateLimitHeaders, rateLimitErrorResponse, RATE_LIMITS } from './rate-limiter';
export type { RateLimitConfig, RateLimitResult };
