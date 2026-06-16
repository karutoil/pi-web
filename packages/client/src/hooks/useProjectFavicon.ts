import { useEffect, useState } from "react";

const cache = new Map<string, string | null>();

export function useProjectFavicon(projectId: string): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(() => cache.get(projectId));

  useEffect(() => {
    const cached = cache.get(projectId);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }

    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/favicon`)
      .then((r) => r.json())
      .then((d: { dataUrl?: string | null }) => {
        const resolved = d.dataUrl ?? null;
        cache.set(projectId, resolved);
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {
        cache.set(projectId, null);
        if (!cancelled) setUrl(null);
      });

    return () => { cancelled = true; };
  }, [projectId]);

  return url;
}
