import type { CSSProperties } from 'react';

/** A CSS animation's start, in seconds from the step opening (`--at` in styles.css). */
const at = (s: number) => ({ '--at': `${s}s` }) as CSSProperties;

/**
 * The tour's welcome picture: a task assistant at work. Your request goes into Harness Relay (its
 * mark, the three dots of the logo, turning as the home page's does) and a result comes out: lines
 * added and removed, and a check that passes. It names no agent, so it stays right whichever and
 * however many there are, and has no words, so it reads the same in every language. It plays once
 * as the step opens (about 4 s), then stays; with reduced motion it is only the still picture. It fills the
 * room the step's text leaves in the card, and is left out when there is too little (styles.css,
 * "Guided tour"). Decorative: the step's text says what Harness Relay is.
 */
export function TourArt() {
  return (
    <div className="tour-art" aria-hidden="true">
      <svg viewBox="0 0 400 300" focusable="false">
        {/* Your request: you, and the lines of what you asked. */}
        <g className="request">
          <rect className="tour-art-card" x="24" y="18" width="196" height="74" rx="14" />
          <circle className="you" cx="54" cy="55" r="17" />
          <circle className="you-icon" cx="54" cy="50" r="5.5" />
          <path className="you-icon" d="M44.5 64.5a9.5 8 0 0 1 19 0Z" />
          <rect className="line" x="83" y="42" width="114" height="9" rx="4.5" style={at(0.35)} />
          <rect className="line" x="83" y="60" width="78" height="9" rx="4.5" style={at(0.45)} />
        </g>

        <path className="edge" pathLength={1} d="M122 96C122 130 140 150 163 150" style={at(0.75)} />
        <path className="tip" d="M0-4 8 0 0 4Z" transform="translate(163 150)" style={at(1.1)} />

        {/* Harness Relay at work: the logo's dots, turning once. */}
        <g className="mark" style={at(0.9)}>
          <circle cx="186" cy="150" r="12" fill="var(--claude)" />
          <circle cx="214" cy="138" r="10" fill="var(--codex)" />
          <circle cx="214" cy="164" r="10" fill="var(--grok)" />
        </g>

        <path className="edge" pathLength={1} d="M235 150C266 150 284 166 284 190" style={at(2.0)} />
        <path className="tip" d="M0-4 8 0 0 4Z" transform="translate(284 190) rotate(90)" style={at(2.35)} />

        {/* The result: lines added and removed, and the checks passing. */}
        <g className="result" style={at(2.2)}>
          <rect className="tour-art-card" x="180" y="204" width="196" height="84" rx="14" />
          <rect className="row add" x="194" y="216" width="128" height="16" rx="5" />
          <path className="sign add" d="M200 224h8M204 220v8" />
          <rect className="bar add line" x="214" y="221" width="88" height="6" rx="3" style={at(2.45)} />
          <rect className="row add" x="194" y="236" width="128" height="16" rx="5" />
          <path className="sign add" d="M200 244h8M204 240v8" />
          <rect className="bar add line" x="214" y="241" width="64" height="6" rx="3" style={at(2.55)} />
          <rect className="row del" x="194" y="256" width="128" height="16" rx="5" />
          <path className="sign del" d="M200 264h8" />
          <rect className="bar del line" x="214" y="261" width="76" height="6" rx="3" style={at(2.65)} />
          <g className="check" style={at(2.9)}>
            <circle className="halo" cx="350" cy="246" r="15" style={at(3.05)} />
            <circle className="tour-art-badge" cx="350" cy="246" r="15" />
            <path className="tick" d="M343 246.5l5 5 9-10" />
          </g>
        </g>
      </svg>
    </div>
  );
}
