"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function SearchBox({
  baseHref,
  initialQuery,
  placeholder = "Search artist or song…",
}: {
  baseHref: string;
  initialQuery: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync external navigations (back/forward, pager) when not typing.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setValue(initialQuery);
  }, [initialQuery]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function push(q: string) {
    const trimmed = q.trim();
    router.replace(trimmed ? `${baseHref}?q=${encodeURIComponent(trimmed)}` : baseHref, { scroll: false });
  }

  function onChange(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(next), 250);
  }

  return (
    <form
      className="results-search"
      action={baseHref}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        push(value);
      }}
    >
      <input
        ref={inputRef}
        name="q"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search artist or song"
        autoComplete="off"
      />
      {value.trim() ? (
        <button
          type="button"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setValue("");
            push("");
            inputRef.current?.focus();
          }}
        >
          Clear
        </button>
      ) : null}
    </form>
  );
}
