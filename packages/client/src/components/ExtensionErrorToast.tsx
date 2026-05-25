import type { ExtensionErrorEntry } from "../lib/types";

interface ExtensionErrorToastProps {
  errors: ExtensionErrorEntry[];
  onDismiss: (index: number) => void;
}

export function ExtensionErrorToast({ errors, onDismiss }: ExtensionErrorToastProps) {
  // Show only the last 3 errors
  const recent = errors.slice(-3);
  if (recent.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm mobile-safe-bottom">
      {recent.map((err, i) => {
        const idx = errors.length - recent.length + i;
        return (
          <div key={`${err.extensionPath}-${idx}`}
            className="bg-red-900/90 border border-red-700 rounded-lg p-3 shadow-lg animate-fade-in-up">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-red-200 text-xs font-medium truncate">
                  Extension Error
                </div>
                <div className="text-red-300 text-xs mt-1 truncate" title={err.extensionPath}>
                  {err.extensionPath.split("/").pop()}
                </div>
                <div className="text-red-400/80 text-xs mt-0.5 truncate" title={err.error}>
                  {err.error}
                </div>
              </div>
              <button onClick={() => onDismiss(idx)}
                className="text-red-400 hover:text-red-200 shrink-0 text-xs p-1.5 touch-target-sm">✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
