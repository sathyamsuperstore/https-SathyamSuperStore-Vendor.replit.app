import type { Request, Response, NextFunction, RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };

export function createRateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.key ?? ((req: Request) => req.ip ?? "anon");

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const k = keyFn(req);
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.count += 1;
    const remaining = Math.max(0, opts.max - b.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(b.resetAt / 1000)));
    if (b.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: `Too many requests. Try again in ${retryAfter}s.`,
      });
      return;
    }
    next();
  };
}
