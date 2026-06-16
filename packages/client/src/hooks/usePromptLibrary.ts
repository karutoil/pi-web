import { useCallback, useEffect, useState } from "react";
import type { CommandInfo } from "@pi-web/shared";

export interface PromptTemplate {
  id: string;
  name: string;
  text: string;
  createdAt: string;
}

const STORAGE_KEY = "pi-web-prompt-library";

function loadTemplates(): PromptTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

function saveTemplates(templates: PromptTemplate[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {}
}

export function usePromptLibrary() {
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => loadTemplates());

  useEffect(() => {
    saveTemplates(templates);
  }, [templates]);

  const add = useCallback((template: Omit<PromptTemplate, "id" | "createdAt">) => {
    const now = new Date().toISOString();
    const t: PromptTemplate = { ...template, id: crypto.randomUUID(), createdAt: now };
    setTemplates(prev => [...prev, t]);
    return t;
  }, []);

  const update = useCallback((id: string, updates: Partial<Omit<PromptTemplate, "id" | "createdAt">>) => {
    setTemplates(prev => prev.map(t => (t.id === id ? { ...t, ...updates } : t)));
  }, []);

  const remove = useCallback((id: string) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
  }, []);

  const commands: CommandInfo[] = templates.map(t => ({
    name: t.name,
    description: "Prompt template",
    source: "prompt",
  }));

  const findByName = useCallback((name: string) => templates.find(t => t.name === name), [templates]);

  const insertText = useCallback((text: string, textarea: HTMLTextAreaElement | null): string => {
    // Place cursor at first placeholder and select the placeholder text
    const placeholder = /\{\{[^}]+\}\}/.exec(text);
    let value = text;
    if (placeholder && textarea) {
      const start = placeholder.index;
      const end = start + placeholder[0].length;
      requestAnimationFrame(() => {
        textarea.setSelectionRange(start, end);
        textarea.focus();
      });
    } else if (textarea) {
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = value.length;
        textarea.focus();
      });
    }
    return value;
  }, []);

  return { templates, add, update, remove, commands, findByName, insertText };
}
