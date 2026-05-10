import { Router } from "express";
import { createRateLimit } from "../middlewares/rate-limit";

const router = Router();

const PIXIAN_ENDPOINT = "https://api.pixian.ai/api/v2/remove-background";

// Defense in depth against cost-runaway on this paid upstream.
// Real per-user auth needs an authenticated mobile client (see
// follow-up "Move from a shared app secret to real user sign-in");
// until that lands, we lean on rate limits + a hard byte cap.
//
// 20 req / minute / IP covers a normal bulk-of-12 plus retries.
const pixianPerMinute = createRateLimit({ windowMs: 60_000, max: 20 });
// 200 req / day / IP catches sustained abuse that stays under the
// per-minute cap. ~17x what a heavy real user would do in a day.
const pixianPerDay = createRateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 200 });

// Soft cap on the decoded image bytes we forward upstream. Pixian
// itself accepts up to ~30MB, but our client always re-encodes to
// 1024x1024 PNG which is well under 4MB; anything larger is almost
// certainly a misuse / accidental payload, so we reject early.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

router.post("/pixian/remove-bg", pixianPerMinute, pixianPerDay, async (req, res) => {
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
        if (j?.message) msg = String(j.message);
        else if (j?.error) msg = String(j.error);
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
