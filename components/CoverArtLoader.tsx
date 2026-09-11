"use client";

import { useEffect, useRef } from "react";

/**
 * Lazy cover-art loader: replaces placeholder spans with cached images.
 * Pages render instantly from DB-cached URLs; only missing ids hit
 * /api/cover-art in one batch after paint.
 */
export function CoverArtLoader({ ids }: { ids: string[] }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ids.length) return;
    done.current = true;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/cover-art", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        if (!response.ok) return;
        const { urls } = (await response.json()) as { urls: Record<string, string | null> };
        if (cancelled) return;
        for (const [id, url] of Object.entries(urls)) {
          if (!url) continue;
          document.querySelectorAll(`[data-cover-id="${CSS.escape(id)}"]`).forEach((el) => {
            if (el.tagName === "IMG") return;
            const img = document.createElement("img");
            img.className = el.className;
            img.src = url;
            img.alt = "";
            img.width = 56;
            img.height = 56;
            img.loading = "lazy";
            el.replaceWith(img);
          });
        }
      } catch {
        // Cover art is decorative; ignore failures.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
