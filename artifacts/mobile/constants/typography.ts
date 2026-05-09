// Typography helpers
//
// Centralizes the font-family names registered in `app/_layout.tsx`
// and provides a tiny utility for picking a Tamil-capable font when a
// string contains Tamil Unicode codepoints. Inter does not render the
// Tamil block, so any text that may include Tamil characters
// (supplier names, item descriptions, notes, etc.) should run through
// `pickFont` to avoid tofu boxes on those rows.

export const Fonts = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",

  tamilRegular: "NotoSansTamil_400Regular",
  tamilMedium: "NotoSansTamil_500Medium",
  tamilBold: "NotoSansTamil_700Bold",
} as const;

export type FontWeight = "regular" | "medium" | "semibold" | "bold";

// Tamil Unicode block: U+0B80–U+0BFF.
const TAMIL_RE = /[\u0B80-\u0BFF]/;

export function hasTamil(text: string | null | undefined): boolean {
  if (!text) return false;
  return TAMIL_RE.test(text);
}

// Picks the right font family for a given string + weight. Falls back
// to Inter for pure Latin/numeric text and switches to Noto Sans Tamil
// the moment any Tamil codepoint is detected.
export function pickFont(
  text: string | null | undefined,
  weight: FontWeight = "regular",
): string {
  const tamil = hasTamil(text);
  switch (weight) {
    case "bold":
      return tamil ? Fonts.tamilBold : Fonts.bold;
    case "semibold":
      // Noto Sans Tamil ships 400/500/700 — map semibold to bold so
      // emphasis still reads as heavier than medium.
      return tamil ? Fonts.tamilBold : Fonts.semibold;
    case "medium":
      return tamil ? Fonts.tamilMedium : Fonts.medium;
    case "regular":
    default:
      return tamil ? Fonts.tamilRegular : Fonts.regular;
  }
}
