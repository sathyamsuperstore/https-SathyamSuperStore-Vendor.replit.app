import { Router } from "express";
import jwt from "jsonwebtoken";
import { createRateLimit } from "../middlewares/rate-limit";

const router = Router();

const SESSION_TTL_DAYS = 60;

// Aggressive throttle on login to make PIN brute-force impractical.
// 10 attempts / minute / IP and 60 / hour / IP are well above any
// realistic legit retry while keeping total guess rate low.
const loginPerMinute = createRateLimit({ windowMs: 60_000, max: 10 });
const loginPerHour = createRateLimit({ windowMs: 60 * 60_000, max: 60 });

// Constant-time string compare to avoid leaking pin length / prefix.
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

router.post("/auth/login", loginPerMinute, loginPerHour, (req, res) => {
  const expectedPin = process.env.ADMIN_PIN;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!expectedPin || !sessionSecret) {
    req.log?.error?.("ADMIN_PIN or SESSION_SECRET not configured");
    res.status(500).json({ error: "Auth is not configured on the server." });
    return;
  }

  const { pin } = (req.body ?? {}) as { pin?: unknown };
  if (typeof pin !== "string" || pin.length === 0) {
    res.status(400).json({ error: "PIN is required." });
    return;
  }
  if (!safeEq(pin, expectedPin)) {
    req.log?.warn?.({ ip: req.ip }, "auth: bad PIN");
    res.status(401).json({ error: "Incorrect PIN." });
    return;
  }

  const token = jwt.sign({ sub: "admin" }, sessionSecret, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
  res.json({ token, expiresInDays: SESSION_TTL_DAYS });
});

export default router;
