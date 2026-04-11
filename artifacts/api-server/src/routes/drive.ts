import { Router } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";

const router = Router();
const connectors = new ReplitConnectors();

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";

router.get("/drive/files", async (req, res) => {
  try {
    const folderId = req.query.folderId as string | undefined;
    const folderClause = folderId ? `'${folderId}' in parents and ` : "";
    const mimeFilter = `(mimeType='${XLSX_MIME}' or mimeType='${GSHEET_MIME}')`;
    const query = `${folderClause}${mimeFilter} and trashed=false`;

    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name,modifiedTime,size,mimeType)",
      orderBy: "modifiedTime desc",
      pageSize: "50",
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
    if (mimeType === GSHEET_MIME) {
      path = `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}&supportsAllDrives=true`;
    } else {
      path = `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    }

    const response = await connectors.proxy("google-drive", path, { method: "GET" });
    const arrayBuffer = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    res.setHeader("Content-Type", XLSX_MIME);
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to download Drive file" });
  }
});

export default router;
