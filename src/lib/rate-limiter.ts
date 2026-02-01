/**
 * Simple in-memory rate limiter for API routes
 * In production, use Redis for distributed rate limiting
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// Store: Map<identifier, RateLimitEntry>
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyPrefix?: string;    // Prefix for rate limit key
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

/**
 * Check rate limit for an identifier (e.g., user ID or IP)
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const key = `${config.keyPrefix || 'rl'}:${identifier}`;
  const entry = rateLimitStore.get(key);

  // If no entry or expired, create new one
  if (!entry || entry.resetTime < now) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + config.windowMs,
    });

    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetTime: now + config.windowMs,
    };
  }

  // Check if limit exceeded
  if (entry.count >= config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime,
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    };
  }

  // Increment count
  entry.count++;
  rateLimitStore.set(key, entry);

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetTime: entry.resetTime,
  };
}

/**
 * Create rate limit response headers
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetTime / 1000)),
  };

  if (!result.allowed && result.retryAfter) {
    headers['Retry-After'] = String(result.retryAfter);
  }

  return headers;
}

/**
 * Create a rate-limited error response
 */
export function rateLimitErrorResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...rateLimitHeaders(result),
      },
    }
  );
}

// Pre-configured rate limits for different endpoints
export const RATE_LIMITS = {
  // Extract API: 10 requests per minute per user
  extract: {
    windowMs: 60 * 1000,
    maxRequests: 10,
    keyPrefix: 'extract',
  },

  // Auth endpoints: 5 requests per minute
  auth: {
    windowMs: 60 * 1000,
    maxRequests: 5,
    keyPrefix: 'auth',
  },

  // Export endpoints: 20 requests per minute
  export: {
    windowMs: 60 * 1000,
    maxRequests: 20,
    keyPrefix: 'export',
  },

  // Webhook endpoints: 100 requests per minute (from Apify)
  webhook: {
    windowMs: 60 * 1000,
    maxRequests: 100,
    keyPrefix: 'webhook',
  },

  // General API: 60 requests per minute
  general: {
    windowMs: 60 * 1000,
    maxRequests: 60,
    keyPrefix: 'api',
  },
} as const;
