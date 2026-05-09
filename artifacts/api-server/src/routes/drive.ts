import { Router } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";

const router = Router();
const connectors = new ReplitConnectors();

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";

// MIME filter clauses by `kind` query param. Default keeps the
// historical behaviour (spreadsheets) so existing callers don't
// break; `images` is used by the mobile PriceTag Preview's Drive
// picker.
function mimeFilterFor(kind: string | undefined): string {
  if (kind === "images") {
    return "(mimeType contains 'image/')";
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

export default router;
