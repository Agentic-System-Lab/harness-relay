import type { CSSProperties, ReactNode } from 'react';
import type { TopicId } from '../tour';
import { BellIcon, BranchIcon, ClockIcon, FolderIcon, KeyIcon, MailIcon, UsersIcon } from './icons';

/** A CSS animation's start, in seconds from the topic opening (`--at` in styles.css). */
const at = (s: number) => ({ '--at': `${s}s` }) as CSSProperties;
/** The same, for a part that comes in from `from` (a transform) rather than from just below. */
const from = (s: number, transform: string) => ({ '--at': `${s}s`, '--from': transform }) as CSSProperties;

/**
 * The guided tour's pictures, one for each topic, in one language: cards of a few lines, the logo's
 * three dots for Harness Relay, agents as coloured dots, the app's own icons, a green check for
 * what worked. They name no agent and have no words, so they stay right in every language and
 * whichever agents there are. Each plays once as its topic opens (a second or two), then stays;
 * with reduced motion it is only the still picture. It takes the room above the topic's text, and
 * is left out when there is too little (styles.css, "Guided tour"). Decorative: the topic's text
 * says what it shows.
 */
export function TourArt({ topic }: { topic: TopicId }) {
  return (
    <div className="tour-art" data-art={topic} aria-hidden="true">
      {PICTURES[topic]()}
    </div>
  );
}

/** One of the app's icons in a picture (24 units, drawn in currentColor). */
function Glyph({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <g className="glyph" transform={`translate(${x} ${y})`}>
      {children}
    </g>
  );
}

/** A green check that pops in and rings once: what is ready, or done. */
function Check({ cx, cy, r = 13, start }: { cx: number; cy: number; r?: number; start: number }) {
  const s = r / 15;
  return (
    <g className="check" style={at(start)}>
      <circle className="halo" cx={cx} cy={cy} r={r} style={at(start + 0.15)} />
      <circle className="tour-art-badge" cx={cx} cy={cy} r={r} />
      <path className="tick" d={`M${cx - 7 * s} ${cy + 0.5 * s}l${5 * s} ${5 * s} ${9 * s}-${10 * s}`} />
    </g>
  );
}

/** Harness Relay: the logo's three dots, turning once. */
function Mark({ x, y, start, scale = 1 }: { x: number; y: number; start: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="mark" style={at(start)}>
        <circle cx="0" cy="0" r="12" fill="var(--claude)" />
        <circle cx="28" cy="-12" r="10" fill="var(--codex)" />
        <circle cx="28" cy="14" r="10" fill="var(--grok)" />
      </g>
    </g>
  );
}

const PICTURES: Record<TopicId, () => ReactNode> = {
  // A task assistant at work: your request goes into Harness Relay, and a result comes out (lines
  // added and removed, and a check that passes).
  welcome: () => (
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
  ),

  // The agents in Settings: one signed in (checked), one to sign in to, one on an API key.
  agents: () => (
    <svg viewBox="0 0 400 280" focusable="false">
      <g className="enter">
        <rect className="tour-art-card" x="64" y="20" width="272" height="240" rx="16" />
        <path className="divider" d="M84 100h232M84 180h232" />
      </g>
      {[
        { y: 60, color: 'var(--claude)', name: 112, sub: 70 },
        { y: 140, color: 'var(--codex)', name: 92, sub: 56 },
        { y: 220, color: 'var(--opencode)', name: 104, sub: 64 },
      ].map((row, n) => (
        <g key={row.y}>
          <circle className="pop" cx="102" cy={row.y} r="15" fill={row.color} style={at(0.2 + n * 0.12)} />
          <rect className="line" x="130" y={row.y - 12} width={row.name} height="9" rx="4.5" style={at(0.35 + n * 0.12)} />
          <rect className="line faint" x="130" y={row.y + 4} width={row.sub} height="7" rx="3.5" style={at(0.45 + n * 0.12)} />
        </g>
      ))}
      {/* Signed in. */}
      <Check cx={305} cy={60} start={1.0} />
      {/* A sign-in button. */}
      <g className="show" style={at(0.8)}>
        <rect className="pill" x="260" y="128" width="58" height="24" rx="12" />
        <rect className="pill-text" x="275" y="137" width="28" height="6" rx="3" />
      </g>
      {/* An API key. */}
      <g className="show" style={at(0.9)}>
        <Glyph x={293} y={208}>
          <KeyIcon size={24} />
        </Glyph>
      </g>
    </svg>
  ),

  // A new chat: your question, its working directory and file permission, sent; the lead agent puts a team together.
  chat: () => (
    <svg viewBox="0 0 400 280" focusable="false">
      <g className="enter">
        <rect className="tour-art-card" x="40" y="148" width="320" height="112" rx="18" />
        <rect className="line" x="64" y="170" width="214" height="9" rx="4.5" style={at(0.25)} />
        <rect className="line" x="64" y="188" width="150" height="9" rx="4.5" style={at(0.35)} />
        {/* The working directory and the file permission. */}
        <g className="show" style={at(0.55)}>
          <rect className="chip" x="64" y="220" width="70" height="24" rx="12" />
          <Glyph x={71} y={225}>
            <FolderIcon size={14} />
          </Glyph>
          <rect className="pill-text" x="91" y="229" width="32" height="6" rx="3" />
          <rect className="chip" x="142" y="220" width="62" height="24" rx="12" />
          <path className="chip-glyph" d="M155 225.5l6 2.2v4.6c0 3.4-2.6 5.6-6 6.7-3.4-1.1-6-3.3-6-6.7v-4.6z" />
          <rect className="pill-text" x="168" y="229" width="26" height="6" rx="3" />
        </g>
        <g className="pop" style={at(0.75)}>
          <circle className="send" cx="330" cy="232" r="15" />
          <path className="send-arrow" d="M330 239v-14M324 231l6-6 6 6" />
        </g>
      </g>
      <path className="edge" pathLength={1} d="M200 146V114" style={at(0.95)} />
      <path className="tip" d="M0-4 8 0 0 4Z" transform="translate(200 112) rotate(-90)" style={at(1.2)} />
      {/* The team. */}
      <g className="enter" style={from(1.15, 'translateY(8px)')}>
        <rect className="tour-art-card surface" x="110" y="22" width="180" height="84" rx="18" />
      </g>
      {['var(--claude)', 'var(--codex)', 'var(--copilot)'].map((color, n) => (
        <circle key={color} className="pop" cx={156 + n * 44} cy="64" r="18" fill={color} style={at(1.3 + n * 0.14)} />
      ))}
      {/* The lead agent's star. */}
      <g className="pop" style={at(1.85)}>
        <circle className="badge-ring" cx="170" cy="48" r="9" />
        <path className="lead-star" d="M170 42.4l1.7 3.9 4.2.4-3.2 2.8 1 4.1-3.7-2.2-3.7 2.2 1-4.1-3.2-2.8 4.2-.4z" />
      </g>
    </svg>
  ),

  // The team at work: a reply coming in, an approval to give, and the bell.
  team: () => (
    <svg viewBox="0 0 400 280" focusable="false">
      <g className="enter">
        <rect className="tour-art-card" x="36" y="20" width="270" height="116" rx="16" />
        <circle cx="64" cy="48" r="12" fill="var(--codex)" />
        <rect className="line" x="86" y="43" width="96" height="9" rx="4.5" style={at(0.2)} />
        <rect className="line" x="58" y="76" width="222" height="8" rx="4" style={at(0.4)} />
        <rect className="line" x="58" y="94" width="196" height="8" rx="4" style={at(0.6)} />
        <rect className="line" x="58" y="112" width="120" height="8" rx="4" style={at(0.8)} />
      </g>
      {/* An approval: allow, or not. */}
      <g className="enter" style={at(1.0)}>
        <rect className="tour-art-card ask" x="36" y="150" width="270" height="110" rx="16" />
        <path className="chip-glyph" d="M64 168l9 3.3v6.9c0 5.1-3.9 8.4-9 10-5.1-1.6-9-4.9-9-10v-6.9z" />
        <rect className="line" x="86" y="170" width="150" height="9" rx="4.5" style={at(1.15)} />
        <rect className="line faint" x="86" y="186" width="100" height="7" rx="3.5" style={at(1.25)} />
        <g className="show" style={at(1.35)}>
          <rect className="allow" x="58" y="218" width="82" height="26" rx="13" />
          <rect className="allow-text" x="79" y="228" width="40" height="6" rx="3" />
          <rect className="pill" x="150" y="218" width="68" height="26" rx="13" />
          <rect className="pill-text" x="167" y="228" width="34" height="6" rx="3" />
        </g>
      </g>
      {/* The bell, with something new. */}
      <g className="enter" style={from(1.5, 'translateY(-8px)')}>
        <circle className="tour-art-card" cx="348" cy="76" r="30" />
        <Glyph x={334} y={62}>
          <BellIcon size={28} />
        </Glyph>
      </g>
      <circle className="halo alert" cx="364" cy="58" r="8" style={at(1.85)} />
      <circle className="dot alert pop" cx="364" cy="58" r="8" style={at(1.7)} />
    </svg>
  ),

  // This computer and your phone, linked: an approval given on the phone.
  phone: () => (
    <svg viewBox="0 0 400 280" focusable="false">
      <g className="enter" style={from(0, 'translateX(-12px)')}>
        <rect className="tour-art-card" x="28" y="66" width="180" height="120" rx="12" />
        <path className="tour-art-card" d="M14 196h208l-10 14H24z" strokeLinejoin="round" />
      </g>
      <Mark x={98} y={126} start={0.25} scale={0.9} />
      <path className="edge" pathLength={1} d="M212 126C236 126 240 118 262 118" style={at(0.8)} />
      <path className="tip" d="M0-4 8 0 0 4Z" transform="translate(262 118)" style={at(1.05)} />
      <g className="enter" style={from(0.35, 'translateX(12px)')}>
        <rect className="tour-art-card" x="272" y="22" width="108" height="236" rx="20" />
        <rect className="line faint" x="310" y="36" width="32" height="6" rx="3" />
        <rect className="line" x="290" y="68" width="72" height="8" rx="4" style={at(1.1)} />
        <rect className="line faint" x="290" y="84" width="52" height="7" rx="3.5" style={at(1.2)} />
        <g className="show" style={at(1.3)}>
          <rect className="allow" x="290" y="206" width="72" height="26" rx="13" />
          <rect className="allow-text" x="308" y="216" width="36" height="6" rx="3" />
        </g>
      </g>
      <Check cx={326} cy={146} r={18} start={1.6} />
    </svg>
  ),

  // What starts an automation (a time, a new mail, a pull request) goes into Harness Relay, and the team's work comes out.
  automations: () => (
    <svg viewBox="0 0 400 280" focusable="false">
      {[
        { y: 34, glyph: <ClockIcon size={26} /> },
        { y: 112, glyph: <MailIcon size={26} /> },
        { y: 190, glyph: <BranchIcon size={26} /> },
      ].map((source, n) => (
        <g key={source.y} className="enter" style={from(n * 0.12, 'translateX(-10px)')}>
          <rect className="tour-art-card" x="30" y={source.y} width="56" height="56" rx="14" />
          <Glyph x={45} y={source.y + 15}>
            {source.glyph}
          </Glyph>
        </g>
      ))}
      <path className="edge" pathLength={1} d="M90 62C130 62 132 136 164 138" style={at(0.45)} />
      <path className="edge" pathLength={1} d="M90 140H164" style={at(0.5)} />
      <path className="edge" pathLength={1} d="M90 218C130 218 132 144 164 142" style={at(0.55)} />
      <Mark x={184} y={140} start={0.7} />
      <path className="edge" pathLength={1} d="M234 140H262" style={at(1.6)} />
      <path className="tip" d="M0-4 8 0 0 4Z" transform="translate(262 140)" style={at(1.85)} />
      <g className="enter" style={from(1.75, 'translateX(10px)')}>
        <rect className="tour-art-card" x="272" y="86" width="104" height="108" rx="14" />
        <rect className="line" x="288" y="104" width="72" height="8" rx="4" style={at(1.9)} />
        <rect className="line" x="288" y="120" width="56" height="8" rx="4" style={at(2.0)} />
        <rect className="line faint" x="288" y="136" width="64" height="7" rx="3.5" style={at(2.1)} />
      </g>
      <Check cx={348} cy={172} start={2.3} />
    </svg>
  ),

  // The apps around Harness Relay: mail, calendar, documents, team chat, connected to it.
  apps: () => (
    <svg viewBox="0 0 400 280" focusable="false">
      {[
        { d: 'M110 70C150 70 150 132 168 136' },
        { d: 'M110 210C150 210 150 148 168 144' },
        { d: 'M290 70C250 70 250 130 238 134' },
        { d: 'M290 210C250 210 250 150 238 146' },
      ].map((edge, n) => (
        <path key={edge.d} className="edge" pathLength={1} d={edge.d} style={at(0.9 + n * 0.08)} />
      ))}
      {[
        { x: 52, y: 42, glyph: <MailIcon size={28} /> },
        { x: 52, y: 182, glyph: <CalendarGlyph /> },
        { x: 290, y: 42, glyph: <FolderIcon size={28} /> },
        { x: 290, y: 182, glyph: <UsersIcon size={28} /> },
      ].map((app, n) => (
        <g key={`${app.x} ${app.y}`} className="enter" style={at(0.35 + n * 0.1)}>
          <rect className="tour-art-card" x={app.x} y={app.y} width="58" height="58" rx="15" />
          <Glyph x={app.x + 15} y={app.y + 15}>
            {app.glyph}
          </Glyph>
        </g>
      ))}
      <Mark x={186} y={140} start={0.1} />
    </svg>
  ),
};

/** A calendar page, drawn as the app's icons are (there is none among them). */
function CalendarGlyph() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}
