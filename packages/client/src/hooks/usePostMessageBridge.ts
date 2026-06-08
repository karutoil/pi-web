/**
 * PostMessage bridge — handles communication between the parent pi-web app
 * and the proxied preview iframe.
 *
 * Validates origin and dispatches typed messages.
 */

import { useEffect, useCallback, useRef } from "react";
import type { SerializedElement } from "@pi-web/shared";
import { usePreviewStore, type ConsoleEntry } from "./usePreviewStore";

export type PreviewMessage =
  | { type: "element:selected"; payload: SerializedElement; autoSend?: boolean; message?: string }
  | { type: "console:error"; payload: { message: string; timestamp: number } }
  | { type: "console:warn"; payload: { message: string; timestamp: number } }
  | { type: "console:log"; payload: { message: string; timestamp: number } };

export function usePostMessageBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
) {
  const addPickedElement = usePreviewStore((s) => s.addPickedElement);
  const addConsoleLog = usePreviewStore((s) => s.addConsoleLog);
  const pickerActive = usePreviewStore((s) => s.pickerActive);

  // Keep ref for picker toggle to avoid stale closure
  const pickerActiveRef = useRef(pickerActive);
  useEffect(() => { pickerActiveRef.current = pickerActive; }, [pickerActive]);

  // Listen for messages from iframe
  useEffect(() => {
    function handler(event: MessageEvent) {
      // Accept messages from our own origin (same-origin) OR from the
      // Hono backend (cross-origin in dev mode, port 3069 vs 3070).
      const isSelf = event.origin === window.location.origin;
      const isLocalhost =
        event.origin.includes('://localhost:') ||
        event.origin.includes('://127.0.0.1:');
      if (!isSelf && !isLocalhost) return;

      const msg = event.data as PreviewMessage;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case "element:selected":
          if (msg.payload && msg.payload.token) {
            addPickedElement(msg.payload, msg.autoSend ? msg.message : undefined);
          }
          break;
        case "console:error":
          addConsoleLog({ level: "error", message: msg.payload.message, timestamp: msg.payload.timestamp });
          break;
        case "console:warn":
          addConsoleLog({ level: "warn", message: msg.payload.message, timestamp: msg.payload.timestamp });
          break;
        case "console:log":
          addConsoleLog({ level: "log", message: msg.payload.message, timestamp: msg.payload.timestamp });
          break;
      }
    }

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [addPickedElement, addConsoleLog]);

  // Send message to iframe
  const postMessage = useCallback(
    (msg: { type: string; [k: string]: unknown }) => {
      const el = iframeRef.current;
      if (el?.contentWindow) {
        el.contentWindow.postMessage(msg, '*');
      }
    },
    [iframeRef],
  );

  // Toggle picker in iframe when store changes
  useEffect(() => {
    if (pickerActiveRef.current) {
      postMessage({ type: "picker:on" });
    } else {
      postMessage({ type: "picker:off" });
    }
  }, [pickerActive, postMessage]);

  return { postMessage };
}
