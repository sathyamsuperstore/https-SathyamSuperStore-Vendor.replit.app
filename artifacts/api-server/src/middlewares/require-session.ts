import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type SessionPayload = { sub: string; iat?: number; exp?: number };

export function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    req.log?.error?.("SESSION_SECRET is not configured");
    res.status(500).json({ error: "Server auth is not configured." });
    return;
  }
  const header = req.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : "";
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}
