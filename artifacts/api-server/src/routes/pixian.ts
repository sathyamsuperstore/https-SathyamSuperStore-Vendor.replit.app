import { Router } from "express";

const router = Router();

const PIXIAN_ENDPOINT = "https://api.pixian.ai/api/v2/remove-background";

router.post("/pixian/remove-bg", async (req, res) => {
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
