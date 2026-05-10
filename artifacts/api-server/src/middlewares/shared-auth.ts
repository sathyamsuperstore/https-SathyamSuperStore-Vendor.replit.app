import type { Request, Response, NextFunction } from "express";

export function requireSharedAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.API_SHARED_SECRET;
  if (!expected) {
    req.log?.error?.("API_SHARED_SECRET is not configured");
    res.status(500).json({ error: "Server auth is not configured." });
    return;
  }
  const header = req.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : "";
  if (!token || token !== expected) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}
