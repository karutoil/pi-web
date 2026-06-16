export interface SymbolOutline {
  name: string;
  kind: "function" | "class" | "interface" | "variable" | "method";
  line: number;
  column: number;
}

export function parseSymbols(content: string): SymbolOutline[] {
  const symbols: SymbolOutline[] = [];
  const lines = content.split("\n");
  const patterns = [
    { kind: "function" as const, regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: "class" as const, regex: /(?:export\s+)?class\s+(\w+)/ },
    { kind: "interface" as const, regex: /(?:export\s+)?interface\s+(\w+)/ },
    { kind: "variable" as const, regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/ },
    { kind: "method" as const, regex: /^(?:\s*)(\w+)\s*\([^)]*\)\s*{/ },
  ];
  lines.forEach((line, idx) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*") || line.trim().startsWith("/*")) return;
    for (const { kind, regex } of patterns) {
      const match = regex.exec(line);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          kind,
          line: idx + 1,
          column: (match.index || 0) + line.slice(match.index || 0).indexOf(match[1]),
        });
        break;
      }
    }
  });
  return symbols;
}
