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

/**
 * The Logo's drawing in motion: made of three elements rather than an SVG, so that its animation runs
 * on the compositor (styles.css, `.logo-motion`). As it appears, the dots spiral in and meet while the
 * mark turns once; with `turning` it then turns again and again, half a second still after each turn.
 * Its size is the class's (`--u`, pixels a unit of the Logo's 32): the home page's (`home-logo`) and a
 * team design's card while the lead agent designs it (`plan-logo`).
 */
export function AnimatedLogo({ className, turning = false }: { className: string; turning?: boolean }) {
  return (
    <div className={`logo-motion ${className}${turning ? ' turning' : ''}`} aria-hidden="true">
      <div className="logo-motion-orbit">
        <span className="logo-dot logo-dot-claude" />
        <span className="logo-dot logo-dot-codex" />
        <span className="logo-dot logo-dot-grok" />
      </div>
    </div>
  );
}

/**
 * The app's loader: the Logo's drawing turning as the team design card's mark does (1.4 s turning in
 * each 1.9 s), wherever something is in progress (a step running, the lead agent revising the team,
 * an install, a sign-in, a voice download, a reply about to begin). It turns from the first moment,
 * without the dots spiralling in, since it comes and goes as steps start and end (styles.css,
 * `.logo-spinner`), and stands still with reduced motion. Inline, `size` pixels square.
 */
export function LogoSpinner({ size = 14 }: { size?: number }) {
  return (
    <span className="logo-motion logo-spinner" style={{ ['--u' as string]: `${size / 32}px` }} aria-hidden="true">
      <span className="logo-motion-orbit">
        <span className="logo-dot logo-dot-claude" />
        <span className="logo-dot logo-dot-codex" />
        <span className="logo-dot logo-dot-grok" />
      </span>
    </span>
  );
}
