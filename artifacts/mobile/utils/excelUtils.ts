import * as fflate from "fflate";

export interface PageSetupOptions {
  paperSize?: number;
  orientation?: "portrait" | "landscape" | "default";
  fitToWidth?: number;
  fitToHeight?: number;
  scale?: number;
}

function buildPageSetupXml(opts: PageSetupOptions): string {
  const attrs: string[] = [];
  if (opts.paperSize   != null) attrs.push(`paperSize="${opts.paperSize}"`);
  if (opts.orientation)         attrs.push(`orientation="${opts.orientation}"`);
  if (opts.fitToWidth  != null) attrs.push(`fitToWidth="${opts.fitToWidth}"`);
  if (opts.fitToHeight != null) attrs.push(`fitToHeight="${opts.fitToHeight}"`);
  if (opts.scale       != null) attrs.push(`scale="${opts.scale}"`);
  return `<pageSetup ${attrs.join(" ")}/>`;
}

export function injectPageSetup(
  xlsxBytes: Uint8Array,
  opts: PageSetupOptions
): Uint8Array {
  try {
    const unzipped = fflate.unzipSync(xlsxBytes);

    // Sanity-check: we must have at least a few expected entries
    const sheetKey = "xl/worksheets/sheet1.xml";
    if (!unzipped[sheetKey]) return xlsxBytes;

    const xml = fflate.strFromU8(unzipped[sheetKey]);

    // Validate the XML is a real sheet (not empty / corrupt)
    if (!xml || !xml.includes("<sheetData") || !xml.includes("</worksheet>")) {
      return xlsxBytes;
    }

    // Remove any existing pageSetup element (self-closing or open+close)
    let modified = xml
      .replace(/<pageSetup[^>]*\/>/g, "")
      .replace(/<pageSetup[^>]*>.*?<\/pageSetup>/g, "");

    // Inject new pageSetup just before </worksheet>
    modified = modified.replace("</worksheet>", buildPageSetupXml(opts) + "</worksheet>");

    const newSheetBytes = fflate.strToU8(modified);
    if (!newSheetBytes || newSheetBytes.length === 0) return xlsxBytes;

    unzipped[sheetKey] = newSheetBytes;

    const result = fflate.zipSync(unzipped);
    if (!result || result.length < 100) return xlsxBytes; // suspiciously small → bail

    return result;
  } catch {
    // Any error: return the original untouched bytes so data is never lost
    return xlsxBytes;
  }
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
