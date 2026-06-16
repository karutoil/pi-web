import { useState } from "react";
import type { PromptTemplate } from "../hooks/usePromptLibrary";

interface Props {
  templates: PromptTemplate[];
  onAdd: (template: Omit<PromptTemplate, "id" | "createdAt">) => void;
  onUpdate: (id: string, updates: Partial<Omit<PromptTemplate, "id" | "createdAt">>) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

export function PromptLibraryModal({ templates, onAdd, onUpdate, onRemove, onClose }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");

  const reset = () => {
    setEditingId(null);
    setName("");
    setText("");
  };

  const startEdit = (t: PromptTemplate) => {
    setEditingId(t.id);
    setName(t.name);
    setText(t.text);
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    const trimmedText = text.trim();
    if (!trimmedName || !trimmedText) return;
    if (editingId) {
      onUpdate(editingId, { name: trimmedName, text: trimmedText });
    } else {
      onAdd({ name: trimmedName, text: trimmedText });
    }
    reset();
  };

  const canSave = name.trim() && text.trim();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-stage">
        <div className="modal-card animate-fade-in-up flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
          <div className="modal-header mobile-safe-top">
            <h2 className="modal-title">Prompt library</h2>
            <button type="button" onClick={onClose} className="modal-close" aria-label="Close">×</button>
          </div>

          <div className="modal-body modal-body--compact flex-1 min-h-0 overflow-auto flex flex-col gap-3">
            <div className="space-y-2">
              <label className="text-ink-200 text-xs font-medium">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. explain-code"
                className="modal-field w-full text-xs"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2 flex-1 flex flex-col min-h-0">
              <label className="text-ink-200 text-xs font-medium">Template</label>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Use {{variable}} for placeholders."
                className="modal-field w-full text-xs font-mono resize-y min-h-[6rem] flex-1"
                spellCheck={false}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className={`modal-button modal-button--primary text-xs ${!canSave ? "opacity-45 cursor-not-allowed" : ""}`}
              >
                {editingId ? "Update" : "Add"}
              </button>
              {editingId && (
                <button type="button" onClick={reset} className="modal-button modal-button--ghost text-xs">
                  New
                </button>
              )}
            </div>

            {templates.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-ink-200 text-xs font-medium">Saved prompts</div>
                <div className="space-y-1">
                  {templates.map(t => (
                    <div
                      key={t.id}
                      className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs ${editingId === t.id ? "bg-amber-500/10" : "hover:bg-ink-800"}`}
                    >
                      <button
                        type="button"
                        onClick={() => startEdit(t)}
                        className="text-left flex-1 truncate text-ink-100"
                        title={t.text}
                      >
                        /{t.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(t.id)}
                        className="text-ink-500 hover:text-rose-400"
                        aria-label={`Delete /${t.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="modal-footer mobile-safe-bottom">
            <button type="button" onClick={onClose} className="modal-button modal-button--primary text-xs">Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
