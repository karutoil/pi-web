import { useState, useEffect } from "react";
import type { ExtensionErrorEntry } from "../lib/types";

interface ExtensionErrorToastProps {
  errors: ExtensionErrorEntry[];
  onDismiss: (index: number) => void;
  onClearAll?: () => void;
}

export function ExtensionErrorToast({ errors, onDismiss, onClearAll }: ExtensionErrorToastProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
  }, []);

  const recent = errors.slice(-3);
  if (recent.length === 0) return null;

  const clearRecent = () => {
    if (onClearAll) onClearAll();
    else recent.forEach((_, i) => onDismiss(errors.length - recent.length + i));
  };

  return (
    <div className={`conversation-extension-toast ${visible ? "is-visible" : "is-entering"}`}>
      {recent.length > 1 && collapsed ? (
        <div className="conversation-extension-toast-row">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="conversation-extension-toast-pill"
            role="alert"
          >
            <span className="conversation-extension-toast-count">{recent.length}</span>
            errors
          </button>
          <button type="button" onClick={clearRecent} className="conversation-extension-toast-link">
            clear all
          </button>
        </div>
      ) : (
        <div className="conversation-extension-toast-stack-inner">
          {recent.length > 1 && (
            <div className="conversation-extension-toast-actions">
              <button type="button" onClick={clearRecent} className="conversation-extension-toast-link">
                clear all
              </button>
              <button type="button" onClick={() => setCollapsed(true)} className="conversation-extension-toast-link">
                collapse
              </button>
            </div>
          )}
          {recent.map((err, i) => {
            const idx = errors.length - recent.length + i;
            return (
              <div
                key={`${err.extensionPath}-${idx}`}
                className="conversation-extension-toast-row"
                role="alert"
              >
                <span className="conversation-extension-toast-dot" />
                <div className="conversation-extension-toast-copy">
                  <span className="conversation-extension-toast-title" title={err.extensionPath}>
                    {err.extensionPath.split("/").pop()}
                  </span>
                  <span className="conversation-extension-toast-message" title={err.error}>
                    {err.error}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onDismiss(idx)}
                  className="conversation-extension-toast-dismiss"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
