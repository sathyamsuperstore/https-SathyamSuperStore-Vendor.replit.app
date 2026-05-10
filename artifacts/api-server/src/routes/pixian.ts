import { Router } from "express";
import { createRateLimit } from "../middlewares/rate-limit";
import { requireSession } from "../middlewares/require-session";

const router = Router();

const PIXIAN_ENDPOINT = "https://api.pixian.ai/api/v2/remove-background";

// Defense in depth against cost-runaway on this paid upstream.
// Real per-user auth needs an authenticated mobile client (see
// follow-up "Move from a shared app secret to real user sign-in");
// until that lands, we lean on rate limits + a hard byte cap.
//
// We enforce per-IP and per-token limits *independently* so neither
// dimension can be multiplied by varying the other (e.g. one stolen
// token cycled across many IPs, or one IP cycling many tokens).
// The token comes from the Authorization header set by
// requireSession; if it's missing we won't get this far anyway, but
// we fall back to "anon" for safety.
function tokenKey(req: import("express").Request): string {
  const header = req.headers.authorization;
  const tok =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : "anon";
  return `tok:${tok}`;
}
function ipKey(req: import("express").Request): string {
  return `ip:${req.ip ?? "unknown"}`;
}
// 20 req / minute covers a normal bulk-of-12 plus retries; 200 req /
// day catches sustained abuse that stays under the per-minute cap.
const pixianPerIpMinute = createRateLimit({ windowMs: 60_000, max: 20, key: ipKey });
const pixianPerIpDay = createRateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 200, key: ipKey });
const pixianPerTokenMinute = createRateLimit({ windowMs: 60_000, max: 20, key: tokenKey });
const pixianPerTokenDay = createRateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 200, key: tokenKey });

// Soft cap on the decoded image bytes we forward upstream. Pixian
// itself accepts up to ~30MB, but our client always re-encodes to
// 1024x1024 PNG which is well under 4MB; anything larger is almost
// certainly a misuse / accidental payload, so we reject early.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

router.post(
  "/pixian/remove-bg",
  requireSession,
  pixianPerIpMinute,
  pixianPerIpDay,
  pixianPerTokenMinute,
  pixianPerTokenDay,
  async (req, res) => {
  const id = process.env.PIXIAN_API_ID;
  const secret = process.env.PIXIAN_API_SECRET;
  if (!id || !secret) {
    res.status(500).json({ error: "Pixian credentials are not configured." });
    return;
  }

  const { imageDataUri } = (req.body ?? {}) as { imageDataUri?: string };
  if (!imageDataUri || typeof imageDataUri !== "string") {
    res.status(400).json({ error: "Missing imageDataUri." });
    return;
  }

  // Accept either a data URI (data:image/...;base64,XXXX) or a bare
  // base64 string. We decode to a Buffer and send as multipart.
  const match = imageDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  let mime = "image/jpeg";
  let b64: string;
  if (match) {
    mime = match[1] ?? mime;
    b64 = match[2] ?? "";
  } else {
    b64 = imageDataUri;
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) throw new Error("empty");
  } catch {
    res.status(400).json({ error: "imageDataUri is not valid base64." });
    return;
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    res.status(413).json({
      error: `Image too large (${mb} MB). Max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
    });
    return;
  }

  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const form = new FormData();
  const ext = mime.split("/")[1] || "jpg";
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mime }), `input.${ext}`);

  try {
    const upstream = await fetch(PIXIAN_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      let msg = `Pixian responded ${upstream.status}`;
      try {
        const j = JSON.parse(text);
        // Pixian wraps errors as { status:"error", error:{ code, message } }.
        // Earlier we did `String(j.error)` which yielded the literal
        // string "[object Object]" — surface the nested message
        // (or top-level message) instead, falling back to a JSON dump.
        const nested =
          (j && typeof j === "object" && j.error && typeof j.error === "object"
            ? (j.error as { message?: unknown }).message
            : undefined);
        if (typeof nested === "string" && nested) {
          msg = nested;
        } else if (typeof j?.message === "string" && j.message) {
          msg = j.message;
        } else if (typeof j?.error === "string" && j.error) {
          msg = j.error;
        } else if (j && typeof j === "object") {
          msg = JSON.stringify(j).slice(0, 200);
        }
      } catch {
        if (text) msg = text.slice(0, 200);
      }
      req.log?.warn?.({ status: upstream.status, msg }, "pixian failure");
      res.status(upstream.status >= 500 ? 502 : upstream.status).json({ error: msg });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const outDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    res.json({ imageDataUri: outDataUri });
  } catch (err: any) {
    req.log?.error?.({ err }, "pixian request failed");
    res.status(502).json({ error: err?.message ?? "Pixian request failed" });
  }
});

export default router;
