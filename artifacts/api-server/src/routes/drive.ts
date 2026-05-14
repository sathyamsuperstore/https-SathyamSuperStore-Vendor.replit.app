import { Router } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { createRateLimit } from "../middlewares/rate-limit";
import { requireSession } from "../middlewares/require-session";
import { UploadDriveFileBody } from "@workspace/api-zod";

const router = Router();
const connectors = new ReplitConnectors();

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Same defense-in-depth posture as /pixian: per-IP and per-token
// independently, so a stolen token cycled across IPs (or vice versa)
// can't multiply the cap. Drive traffic is heavier than pixian
// (folder browsing, thumbnails) but still cheap, so 60/min is a
// reasonable ceiling for normal interactive use.
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
const drivePerIpMinute = createRateLimit({ windowMs: 60_000, max: 60, key: ipKey });
const drivePerTokenMinute = createRateLimit({ windowMs: 60_000, max: 60, key: tokenKey });

router.use("/drive", requireSession, drivePerIpMinute, drivePerTokenMinute);

// MIME filter clauses by `kind` query param. Default keeps the
// historical behaviour (spreadsheets) so existing callers don't
// break; `images` is used by the mobile PriceTag Preview's Drive
// picker — and includes folders so the user can drill into a
// shared folder of pictures.
function mimeFilterFor(kind: string | undefined): string {
  if (kind === "images") {
    return `(mimeType contains 'image/' or mimeType='${FOLDER_MIME}')`;
  }
  if (kind === "folders") {
    return `(mimeType='${FOLDER_MIME}')`;
  }
  return `(mimeType='${XLSX_MIME}' or mimeType='${GSHEET_MIME}')`;
}

router.get("/drive/files", async (req, res) => {
  try {
    const folderId = req.query.folderId as string | undefined;
    const kind = req.query.kind as string | undefined;
    const search = (req.query.search as string | undefined)?.trim();

    const clauses: string[] = [];
    if (folderId) clauses.push(`'${folderId}' in parents`);
    clauses.push(mimeFilterFor(kind));
    if (search) {
      const safe = search.replace(/'/g, "\\'");
      clauses.push(`name contains '${safe}'`);
    }
    clauses.push("trashed=false");
    const query = clauses.join(" and ");

    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name,modifiedTime,size,mimeType,thumbnailLink,iconLink)",
      orderBy: "modifiedTime desc",
      pageSize: "100",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });

    const response = await connectors.proxy(
      "google-drive",
      `/drive/v3/files?${params.toString()}`,
      { method: "GET" }
    );
    const data = (await response.json()) as any;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to list Drive files" });
  }
});

router.get("/drive/file/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;
    const mimeType = req.query.mimeType as string | undefined;

    let path: string;
    let isExport = false;
    if (mimeType === GSHEET_MIME) {
      path = `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}&supportsAllDrives=true`;
      isExport = true;
    } else {
      path = `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    }

    const response = await connectors.proxy("google-drive", path, { method: "GET" });
    const arrayBuffer = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    // For Sheets exports we always emit XLSX. For raw downloads
    // (images, PDFs, native XLSX, etc.) we honour whatever the
    // upstream told us — falling back to octet-stream so the
    // browser still consumes the bytes correctly.
    const upstreamCt = response.headers.get("content-type");
    res.setHeader(
      "Content-Type",
      isExport ? XLSX_MIME : upstreamCt ?? "application/octet-stream"
    );
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to download Drive file" });
  }
});

// ----------------------------------------------------------------
// Drive upload
// ----------------------------------------------------------------
//
// Accepts a base64-encoded file plus optional `folderName`. When
// `folderName` is provided we look it up by name at Drive root and
// create it on demand if missing, then place the new file inside.
// Used by the mobile PriceTag Review PNG export so credentials stay
// server-side. Sits behind the same /drive auth + rate limit chain.

async function findFolderByName(name: string): Promise<string | null> {
  const safe = name.replace(/'/g, "\\'");
  const q = `name='${safe}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name)",
    pageSize: "1",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
  });
  const resp = await connectors.proxy(
    "google-drive",
    `/drive/v3/files?${params.toString()}`,
    { method: "GET" },
  );
  if (!resp.ok) {
    throw new Error(
      `Drive folder lookup failed (${resp.status} ${resp.statusText}).`,
    );
  }
  const data = (await resp.json()) as { files?: Array<{ id: string }> };
  return data.files?.[0]?.id ?? null;
}

async function createFolder(name: string): Promise<string> {
  const resp = await connectors.proxy(
    "google-drive",
    "/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `Drive folder create failed (${resp.status} ${resp.statusText}).`,
    );
  }
  const data = (await resp.json()) as { id?: string };
  if (!data.id) throw new Error("Drive folder create returned no id.");
  return data.id;
}

async function ensureFolder(name: string): Promise<string> {
  const existing = await findFolderByName(name);
  if (existing) return existing;
  return createFolder(name);
}

router.post("/drive/upload", async (req, res) => {
  let parsed;
  try {
    parsed = UploadDriveFileBody.parse(req.body);
  } catch (err: any) {
    res
      .status(400)
      .json({
        error: err?.issues?.[0]?.message ?? "Invalid upload payload.",
      });
    return;
  }
  const { filename, mimeType, dataBase64, folderName } = parsed;

  // Strip an optional `data:<mime>;base64,` prefix so callers can
  // pass either form. Decode once on the server to validate the
  // bytes and reject obviously malformed payloads early.
  const cleaned = dataBase64.replace(/^data:[^;]+;base64,/, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(cleaned, "base64");
    if (buf.length === 0) throw new Error("empty");
  } catch {
    res.status(400).json({ error: "dataBase64 is not valid base64." });
    return;
  }

  // 10 MB hard cap. The PriceTag PNG contract says ≤295 KB so this
  // is generous headroom while still bounding worst-case memory.
  const MAX_BYTES = 10 * 1024 * 1024;
  if (buf.length > MAX_BYTES) {
    res.status(413).json({ error: "Upload exceeds 10 MB limit." });
    return;
  }

  try {
    let folderId: string | null = null;
    if (folderName && folderName.trim()) {
      folderId = await ensureFolder(folderName.trim());
    }

    const metadata: Record<string, unknown> = {
      name: filename,
      mimeType,
    };
    if (folderId) metadata.parents = [folderId];

    // Drive v3 multipart upload: JSON metadata + base64 bytes joined
    // by a boundary. Content-Transfer-Encoding: base64 lets us send
    // the cleaned base64 string directly without re-encoding to
    // binary first.
    const boundary =
      "----sathyam-drive-" + Math.random().toString(36).slice(2);
    const head =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = Buffer.concat([
      Buffer.from(head, "utf8"),
      Buffer.from(cleaned, "utf8"),
      Buffer.from(tail, "utf8"),
    ]);

    const upResp = await connectors.proxy(
      "google-drive",
      `/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );

    if (!upResp.ok) {
      const text = await upResp.text().catch(() => "");
      req.log?.error?.(
        { status: upResp.status, body: text.slice(0, 400) },
        "drive upload failed",
      );
      res.status(502).json({
        error: `Drive upload failed (${upResp.status} ${upResp.statusText}).`,
      });
      return;
    }

    const data = (await upResp.json()) as {
      id?: string;
      name?: string;
      webViewLink?: string;
    };
    if (!data.id || !data.name) {
      res.status(502).json({ error: "Drive upload returned no file id." });
      return;
    }

    res.json({
      id: data.id,
      name: data.name,
      webViewLink: data.webViewLink ?? null,
      folderId,
    });
  } catch (err: any) {
    req.log?.error?.({ err: err?.message }, "drive upload error");
    res
      .status(500)
      .json({ error: err?.message ?? "Failed to upload file to Drive." });
  }
});

export default router;
