import { Router } from "express";
import { execSync } from "node:child_process";
import puppeteer, { type Browser } from "puppeteer";
import {
  buildSingleTagHtml,
  buildSquareShowcaseHtml,
  LOGO_BASE64,
  type PriceTagRenderItem,
  type PriceTagStyle,
} from "@workspace/pricetag-html";
import { RenderPriceTagBody } from "@workspace/api-zod";
import { createRateLimit } from "../middlewares/rate-limit";

const router = Router();

// Cap per-IP at 30/min — this endpoint launches a Chromium tab per
// call so it's heavier than JSON CRUD. Plenty for interactive use
// (1 click ≈ 1 call) but keeps a misbehaving client from chewing
// CPU.
const ipKey = (req: import("express").Request) => `ip:${req.ip ?? "unknown"}`;
const renderLimit = createRateLimit({ windowMs: 60_000, max: 30, key: ipKey });

// Resolve the Chromium binary once at module load. We prefer the Nix
// system `chromium` package because Puppeteer's bundled Chrome links
// against glibc/glib/nss libs that aren't on NixOS by default. If the
// user provides PUPPETEER_EXECUTABLE_PATH that wins. If neither is
// available we fall back to puppeteer's bundled binary and let the
// launch fail loudly with a useful error.
function resolveChromiumPath(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  try {
    return execSync("which chromium", { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}
const CHROMIUM_PATH = resolveChromiumPath();

// ---------------------------------------------------------------------------
// Singleton headless Chromium
//
// Launching Chromium costs ~2-4s. Keeping one warm browser around makes
// subsequent renders ~300-600ms (just opening a fresh page). We lazily
// launch on first request, never close (the process exits when the
// server does).
// ---------------------------------------------------------------------------
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        // The on-launch then() below registers a disconnect handler so
        // that if Chromium crashes (OOM etc.) we drop the cached
        // promise and the next request relaunches a fresh browser.
        // Without this, a crash leaves us holding a dead handle and
        // every render fails until the server restarts.
        headless: true,
        executablePath: CHROMIUM_PATH,
        // --no-sandbox is required because the Replit container doesn't
        // grant the kernel namespace caps Chromium's sandbox needs.
        // Acceptable here because we only ever load HTML we generated
        // ourselves — no untrusted URLs are navigated to.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--font-render-hinting=none",
        ],
      })
      .then((browser) => {
        browser.once("disconnected", () => {
          // Allow the next request to relaunch a fresh browser.
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        // Reset so the next call retries instead of being stuck on a
        // failed launch promise forever.
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// Reject obviously dangerous imageUri values before handing them to
// Chromium. We allow `data:` URIs (no network) and public-looking
// http(s) URLs. Block any URL pointing at loopback, link-local, or
// private RFC1918 ranges so a malicious request can't pivot through
// our server to scan internal services or cloud metadata endpoints
// (e.g. http://169.254.169.254/).
function isImageUriSafe(raw: unknown): { ok: true } | { ok: false; reason: string } {
  if (raw == null || raw === "") return { ok: true };
  if (typeof raw !== "string") return { ok: false, reason: "imageUri must be a string" };
  if (raw.startsWith("data:")) return { ok: true };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "imageUri is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `imageUri protocol ${url.protocol} not allowed` };
  }
  const host = url.hostname.toLowerCase();
  const blockedExact = new Set(["localhost", "0.0.0.0", "::1", "::"]);
  if (blockedExact.has(host)) return { ok: false, reason: "imageUri host is loopback" };
  // 127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12, link-local 169.254.x.x.
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { ok: false, reason: "imageUri host is in a private range" };
  }
  return { ok: true };
}

router.post("/pricetag/render", renderLimit, async (req, res) => {
  // Validate input via the generated Zod schema. Coerces numeric/
  // boolean/string body fields per the orval config so the mobile
  // can keep sending mrp/promotionPrice as either strings or numbers
  // (matches how AppContext stores them).
  const parsed = RenderPriceTagBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issues: parsed.error.issues }, "pricetag/render: bad input");
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues,
    });
    return;
  }

  const { item, style, showLogo, widthPx: rawWidth, scale: rawScale, aspect } = parsed.data;

  const safety = isImageUriSafe(item.imageUri);
  if (!safety.ok) {
    req.log.warn({ reason: safety.reason }, "pricetag/render: blocked imageUri");
    res.status(400).json({ error: `Invalid imageUri: ${safety.reason}` });
    return;
  }
  const isSquare = aspect === "square";
  // Square defaults to a wider body (540px) so a 1080px Instagram
  // export only needs scale=2. Banner keeps the original 380px PDF
  // grid column width.
  const widthPx = rawWidth ?? (isSquare ? 540 : 380);
  const scale = rawScale ?? 4;

  const html = isSquare
    ? buildSquareShowcaseHtml(
        item as PriceTagRenderItem,
        showLogo,
        LOGO_BASE64,
        { widthPx },
      )
    : buildSingleTagHtml(
        item as PriceTagRenderItem,
        style as PriceTagStyle,
        showLogo,
        LOGO_BASE64,
        { widthPx },
      );

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({
      width: widthPx,
      // Square needs an exact widthPx height so the body fits without
      // a scrollbar. Banner uses an arbitrary tall viewport because
      // the clip below shrinks to body bbox.
      height: isSquare ? widthPx : 600,
      deviceScaleFactor: scale,
    });
    // Use `domcontentloaded` + a manual font/image wait. `networkidle0`
    // hangs forever on the Google Fonts <link> tag in some sandbox
    // configs; this is faster and just as reliable for our content.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15_000 });
    // Wait for fonts + images inside the page. We use a string body
    // because this runs in Chromium (browser globals only) — TS would
    // complain about `document` here in our node-targeted tsconfig.
    await page.evaluate(`(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(img =>
        img.complete
          ? Promise.resolve()
          : new Promise(resolve => {
              img.onload = () => resolve();
              img.onerror = () => resolve();
            })
      ));
    })()`);

    // Measure actual content size so the screenshot is cropped tight
    // around the tag. fullPage would pad to viewport height; explicit
    // `clip` matches `body`'s bounding box exactly. For square output
    // we skip the measurement and use widthPx × widthPx so the result
    // is a perfect 1:1 even if the body has 1px subpixel slack.
    let clipW = widthPx;
    let clipH = widthPx;
    if (!isSquare) {
      const dims = await page.evaluate(`(() => {
        const b = document.body;
        const r = b.getBoundingClientRect();
        return { w: Math.ceil(r.width), h: Math.ceil(b.scrollHeight || r.height) };
      })()`) as { w: number; h: number };
      clipW = Math.max(1, dims.w || widthPx);
      clipH = Math.max(1, dims.h || 200);
    }

    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 95,
      omitBackground: false,
      clip: { x: 0, y: 0, width: clipW, height: clipH },
    });

    res.json({
      base64: Buffer.from(buffer).toString("base64"),
      mimeType: "image/jpeg",
      widthPx: clipW * scale,
      heightPx: clipH * scale,
    });
  } catch (err: any) {
    req.log.error({ err: err?.message }, "pricetag/render: render failed");
    res.status(500).json({ error: err?.message ?? "Render failed" });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

export default router;
