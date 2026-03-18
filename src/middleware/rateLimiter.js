import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for presign endpoints.
 * 10 requests per 10 minutes per IP.
 */
export const presignRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait before trying again.' },
  keyGenerator: (req) => {
    // Respect X-Forwarded-For for proxied deployments (e.g. Railway)
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : req.ip;
  },
});
