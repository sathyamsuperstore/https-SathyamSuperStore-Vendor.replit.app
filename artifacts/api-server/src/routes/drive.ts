import { Router } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";

const router = Router();
const connectors = new ReplitConnectors();

router.get("/drive/files", async (req, res) => {
  try {
    const folderId = req.query.folderId as string | undefined;
    let query = "mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false";
    if (folderId) {
      query = `'${folderId}' in parents and ${query}`;
    }
    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name,modifiedTime,size)",
      orderBy: "modifiedTime desc",
      pageSize: "50",
    });
    const response = await connectors.proxy("google-drive", `/drive/v3/files?${params.toString()}`, {
      method: "GET",
    });
    const data = await response.json() as any;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to list Drive files" });
  }
});

router.get("/drive/file/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;
    const response = await connectors.proxy(
      "google-drive",
      `/drive/v3/files/${fileId}?alt=media`,
      { method: "GET" }
    );
    const arrayBuffer = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to download Drive file" });
  }
});

export default router;
