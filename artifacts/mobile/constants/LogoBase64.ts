// Re-export the canonical logo from the shared @workspace/pricetag-html
// lib so the mobile PDF export and the api-server JPEG renderer use the
// exact same bytes. Update the source at lib/pricetag-html/src/logo.ts.
export { LOGO_BASE64 } from "@workspace/pricetag-html";
