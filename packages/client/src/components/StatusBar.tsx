interface StatusBarProps {
  entries: Record<string, string>;
}

/** Strip ANSI escape sequences from text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

export function StatusBarTop(_props: StatusBarProps) { return null; }
export function StatusBarBottom(_props: StatusBarProps) { return null; }

export { stripAnsi };
