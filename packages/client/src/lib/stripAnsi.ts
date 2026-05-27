/** Strip ANSI escape sequences from text */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}
