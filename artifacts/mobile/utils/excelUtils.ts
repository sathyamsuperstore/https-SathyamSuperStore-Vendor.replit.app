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
  if (opts.paperSize  != null) attrs.push(`paperSize="${opts.paperSize}"`);
  if (opts.orientation)        attrs.push(`orientation="${opts.orientation}"`);
  if (opts.fitToWidth  != null) attrs.push(`fitToWidth="${opts.fitToWidth}"`);
  if (opts.fitToHeight != null) attrs.push(`fitToHeight="${opts.fitToHeight}"`);
  if (opts.scale       != null) attrs.push(`scale="${opts.scale}"`);
  return `<pageSetup ${attrs.join(" ")}/>`;
}

export function injectPageSetup(
  xlsxBytes: Uint8Array,
  opts: PageSetupOptions
): Uint8Array {
  const unzipped = fflate.unzipSync(xlsxBytes);
  const sheetKey = "xl/worksheets/sheet1.xml";
  if (unzipped[sheetKey]) {
    let xml = fflate.strFromU8(unzipped[sheetKey]);
    xml = xml.replace(/<pageSetup[^/]*\/>/g, "");
    xml = xml.replace("</worksheet>", buildPageSetupXml(opts) + "</worksheet>");
    unzipped[sheetKey] = fflate.strToU8(xml);
  }
  return fflate.zipSync(unzipped);
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
