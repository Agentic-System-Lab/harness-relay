/** The Harness Relay mark — the same drawing as the favicon in index.html. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="9" cy="16" r="6" fill="var(--claude)" />
      <circle cx="23" cy="10" r="5" fill="var(--codex)" />
      <circle cx="23" cy="23" r="5" fill="var(--grok)" />
    </svg>
  );
}
