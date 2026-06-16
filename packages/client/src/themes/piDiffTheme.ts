import { registerCustomTheme } from "@pierre/diffs";

function alpha(hex: string, a: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return hex;
  const alphaHex = Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${normalized}${alphaHex}`;
}

const palettes = {
  dark: {
    bg: {
      editor: "#1c1a16",
      gutter: "#24221d",
      header: "#2c2924",
    },
    fg: {
      base: "#cbc3b4",
      muted: "#b0a798",
      lineNumber: "#7d7568",
      lineNumberActive: "#90897c",
    },
    accent: {
      primary: "#d4a020",
      border: "#403c35",
    },
    syntax: {
      comment: "#90897c",
      string: "#d4a020",
      number: "#e8b830",
      keyword: "#3dab94",
      variable: "#e0d9cb",
      parameter: "#cbc3b4",
      func: "#f5c842",
      type: "#5ec4b0",
      operator: "#90897c",
      punctuation: "#7d7568",
    },
    states: {
      add: "#3dab94",
      remove: "#e8515c",
    },
  },
  light: {
    bg: {
      editor: "#fcfaf6",
      gutter: "#f5f1eb",
      header: "#ede7df",
    },
    fg: {
      base: "#423b33",
      muted: "#60584e",
      lineNumber: "#a0988b",
      lineNumberActive: "#80776b",
    },
    accent: {
      primary: "#c08d0e",
      border: "#d8d0c5",
    },
    syntax: {
      comment: "#80776b",
      string: "#c08d0e",
      number: "#d9a316",
      keyword: "#359e88",
      variable: "#2a241e",
      parameter: "#423b33",
      func: "#f0b820",
      type: "#4db5a0",
      operator: "#60584e",
      punctuation: "#90897c",
    },
    states: {
      add: "#359e88",
      remove: "#cd2b35",
    },
  },
};

export function makePiDiffTheme(kind: "light" | "dark") {
  const c = palettes[kind];
  const isDark = kind === "dark";

  return {
    name: `pi-web-diff-${kind}`,
    type: kind,
    colors: {
      "editor.background": c.bg.editor,
      "editor.foreground": c.fg.base,
      "editorGutter.background": c.bg.gutter,
      "editorLineNumber.foreground": c.fg.lineNumber,
      "editorLineNumber.activeForeground": c.fg.lineNumberActive,
      "editor.selectionBackground": alpha(c.accent.primary, isDark ? 0.25 : 0.18),
      "editor.inactiveSelectionBackground": alpha(c.accent.primary, isDark ? 0.18 : 0.12),
      "editor.lineHighlightBackground": alpha(c.accent.primary, isDark ? 0.06 : 0.05),
      "editorCursor.foreground": c.accent.primary,
      "diffEditor.insertedTextBackground": alpha(c.states.add, isDark ? 0.12 : 0.16),
      "diffEditor.insertedTextForeground": c.states.add,
      "diffEditor.removedTextBackground": alpha(c.states.remove, isDark ? 0.12 : 0.16),
      "diffEditor.removedTextForeground": c.states.remove,
      "diffEditor.diagonalFill": c.accent.border,
      "focusBorder": c.accent.primary,
      "foreground": c.fg.base,
    },
    tokenColors: [
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.syntax.comment } },
      { scope: ["string", "string.quoted", "string.template"], settings: { foreground: c.syntax.string } },
      { scope: ["constant.numeric", "constant.language.boolean"], settings: { foreground: c.syntax.number } },
      { scope: "keyword", settings: { foreground: c.syntax.keyword } },
      { scope: ["storage", "storage.type", "storage.modifier"], settings: { foreground: c.syntax.keyword } },
      { scope: ["variable", "identifier", "meta.definition.variable"], settings: { foreground: c.syntax.variable } },
      { scope: "variable.parameter", settings: { foreground: c.syntax.parameter } },
      { scope: ["support.function", "entity.name.function"], settings: { foreground: c.syntax.func } },
      { scope: ["support.type", "entity.name.type", "entity.name.class"], settings: { foreground: c.syntax.type } },
      { scope: ["keyword.operator"], settings: { foreground: c.syntax.operator } },
      { scope: ["punctuation"], settings: { foreground: c.syntax.punctuation } },
    ],
    semanticTokenColors: {
      comment: c.syntax.comment,
      string: c.syntax.string,
      number: c.syntax.number,
      keyword: c.syntax.keyword,
      variable: c.syntax.variable,
      parameter: c.syntax.parameter,
      function: c.syntax.func,
      type: c.syntax.type,
      class: c.syntax.type,
    },
  };
}

export const piDiffLight = makePiDiffTheme("light");
export const piDiffDark = makePiDiffTheme("dark");

// Register once for Pierre's shared highlighter. Importing this module
// is enough; both DiffRenderer and GitBlame depend on it.
registerCustomTheme("pi-web-diff-dark", () => Promise.resolve(piDiffDark));
registerCustomTheme("pi-web-diff-light", () => Promise.resolve(piDiffLight));
