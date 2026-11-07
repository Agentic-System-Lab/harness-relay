// Harness Relay landing page: copy buttons, the demo's chapter rail, the mode diagrams and the
// language preference. Everything on the page works without this file; it only adds behaviour.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private windows, site data off); the page works without it.
  }
  return null;
}

// ---------- Language: remember an explicit choice so the root page stops redirecting ----------

for (const link of document.querySelectorAll('[data-lang]')) {
  link.addEventListener('click', () => store('hr-lang', link.dataset.lang));
}

// ---------- Header border once the page scrolls ----------

const header = document.querySelector('.site-header');
if (header) {
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// ---------- Copy buttons ----------

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const text = source.innerText.replace(/^\$ /gm, '').trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    const label = button.getAttribute('aria-label');
    button.classList.add('is-done');
    button.setAttribute('aria-label', button.dataset.done || label);
    clearTimeout(button._timer);
    button._timer = setTimeout(() => {
      button.classList.remove('is-done');
      button.setAttribute('aria-label', label);
    }, 1800);
  });
}

// ---------- Demo video and its chapter rail ----------

const video = document.getElementById('demo-video');
const chapters = [...document.querySelectorAll('.chapter')];

if (video && chapters.length) {
  const starts = chapters.map((c) => Number(c.dataset.t));
  let current = -1;
  let pausedByUser = false;
  let pausingForView = false;

  const endOf = (i) => (i + 1 < starts.length ? starts[i + 1] : video.duration || starts[i] + 15);

  const render = () => {
    const t = video.currentTime;
    let i = 0;
    while (i + 1 < starts.length && t >= starts[i + 1]) i++;
    if (i !== current) {
      chapters[current]?.removeAttribute('aria-current');
      chapters[i].setAttribute('aria-current', 'true');
      current = i;
    }
    const span = endOf(i) - starts[i];
    const p = span > 0 ? Math.min(1, Math.max(0, (t - starts[i]) / span)) : 0;
    chapters[i].style.setProperty('--p', p.toFixed(4));
  };

  // timeupdate fires ~4 times a second; follow playback per frame while it runs.
  let raf = 0;
  const tick = () => {
    render();
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  };
  video.addEventListener('play', () => {
    pausedByUser = false;
    if (!raf) raf = requestAnimationFrame(tick);
  });
  video.addEventListener('pause', () => {
    if (!pausingForView) pausedByUser = true;
    pausingForView = false;
  });
  video.addEventListener('timeupdate', render);
  video.addEventListener('seeked', render);
  render();

  const load = () => {
    if (video.preload !== 'auto') {
      video.preload = 'auto';
      if (video.readyState === 0) video.load();
    }
  };

  const seek = (t) => {
    load();
    const go = () => {
      video.currentTime = t;
      render();
      video.play().catch(() => {});
    };
    if (video.readyState >= 1) go();
    else video.addEventListener('loadedmetadata', go, { once: true });
  };

  chapters.forEach((chapter, i) => {
    chapter.addEventListener('click', () => {
      pausedByUser = false;
      seek(starts[i]);
    });
  });

  // Play while the screen is in view, unless the visitor paused it or prefers less motion.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!pausedByUser && !reduceMotion.matches) {
            load();
            video.play().catch(() => {});
          }
        } else if (!video.paused) {
          pausingForView = true;
          video.pause();
        }
      },
      { threshold: 0.35 },
    ).observe(video);
  }
}

// ---------- Mode tabs and diagrams ----------

const tabs = [...document.querySelectorAll('.modes-tabs [role="tab"]')];
const panels = [...document.querySelectorAll('.mode-panel')];

const STEP_MS = 850;
const HOLD_MS = 2600;
let timer = 0;

function setStep(svg, step) {
  for (const el of svg.querySelectorAll('[data-step]')) {
    const from = Number(el.dataset.step);
    const until = el.dataset.until ? Number(el.dataset.until) : Infinity;
    el.classList.toggle('on', step >= from && step < until);
  }
  for (const el of svg.querySelectorAll('[data-now]')) {
    const steps = el.dataset.now.split(' ').map(Number);
    el.classList.toggle('now', steps.includes(step));
  }
}

function play(svg) {
  clearTimeout(timer);
  const last = Number(svg.dataset.steps);
  if (reduceMotion.matches) {
    setStep(svg, last);
    return;
  }
  let step = 0;
  setStep(svg, step);
  const next = () => {
    step = step >= last ? 0 : step + 1;
    setStep(svg, step);
    timer = setTimeout(next, step === last ? HOLD_MS : step === 0 ? 500 : STEP_MS);
  };
  timer = setTimeout(next, 400);
}

function select(index, focus) {
  tabs.forEach((tab, i) => {
    const on = i === index;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    panels[i].classList.toggle('is-active', on);
  });
  if (focus) tabs[index].focus();
  const svg = panels[index].querySelector('.mode-svg');
  if (svg) play(svg);
}

if (tabs.length && tabs.length === panels.length) {
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i, false));
    tab.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const k = keys[e.key];
      const to = k === 'first' ? 0 : k === 'last' ? tabs.length - 1 : (i + k + tabs.length) % tabs.length;
      select(to, true);
    });
  });

  // Only run the diagram while the section is on screen.
  const section = document.getElementById('modes');
  let active = 0;
  tabs.forEach((tab, i) => tab.addEventListener('click', () => (active = i)));
  select(0, false);
  clearTimeout(timer);
  if ('IntersectionObserver' in window && section) {
    new IntersectionObserver(
      ([entry]) => {
        active = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
        if (entry.isIntersecting) select(active, false);
        else clearTimeout(timer);
      },
      { threshold: 0.2 },
    ).observe(section);
  } else {
    select(0, false);
  }
  reduceMotion.addEventListener?.('change', () => select(Math.max(0, active), false));
}
