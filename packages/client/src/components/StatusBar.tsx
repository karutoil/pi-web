import { stripAnsi } from "../lib/stripAnsi";

interface StatusBarProps {
  entries: Record<string, string>;
}

export function StatusBarTop(_props: StatusBarProps) { return null; }
export function StatusBarBottom(_props: StatusBarProps) { return null; }
