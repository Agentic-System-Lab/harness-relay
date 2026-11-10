// Harness Relay landing page: copy buttons, the GitHub star count, the demo's chapter rail, the mode
// diagrams and the language preference. Everything on the page works without this file; it only adds
// behaviour.

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

// ---------- Language: remember the visitor's choice; both pages' <head> scripts honour it ----------

for (const link of document.querySelectorAll('[data-lang]')) {
  link.addEventListener('click', () => store('harness-relay.lang', link.dataset.lang));
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

// ---------- The repository's star count on the GitHub buttons ----------

// Read from GitHub's API when the page loads. The API allows a visitor 60 unauthenticated requests
// an hour, so the count is kept for ten minutes (also across the two languages). When GitHub can't
// be reached the last count is shown, and without one the buttons just show no count.
const starSlots = [...document.querySelectorAll('[data-stars]')];

if (starSlots.length && 'fetch' in window) {
  const KEY = 'harness-relay.stars';
  const FRESH_MS = 10 * 60 * 1000;
  // Short like GitHub's own counts, in the page's language: 999, 1.2K, 12.3K, 123K, 1.2M on the
  // English page; 999, 1,234, 1.2萬, 12.3萬, 123萬 on the Chinese one. The decimal goes once three
  // digits come before it.
  const lang = document.documentElement.lang || 'en';
  const compact = (digits) =>
    new Intl.NumberFormat(lang, { notation: 'compact', useGrouping: true, maximumFractionDigits: digits });
  const oneDecimal = compact(1);
  const noDecimal = compact(0);
  const format = (count) => {
    const text = oneDecimal.format(count);
    return /\d{3}\.\d/.test(text) ? noDecimal.format(count) : text;
  };

  const show = (count) => {
    for (const slot of starSlots) {
      slot.querySelector('.stars-n').textContent = format(count);
      slot.hidden = false;
    }
  };

  let saved = null;
  try {
    saved = JSON.parse(store(KEY) || 'null');
  } catch {}
  const valid = saved && Number.isInteger(saved.count) && saved.count >= 0;

  if (valid) show(saved.count);
  if (!valid || !(Date.now() - saved.at < FRESH_MS)) {
    fetch('https://api.github.com/repos/Agentic-System-Lab/harness-relay', {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((repo) => {
        const count = repo?.stargazers_count;
        if (!Number.isInteger(count) || count < 0) return;
        show(count);
        store(KEY, JSON.stringify({ count, at: Date.now() }));
      })
      .catch(() => {});
  }
}

// ---------- Demo video and its chapter rail ----------

const video = document.getElementById('demo-video');
const chapters = [...document.querySelectorAll('.chapter')];
const list = document.querySelector('.chapters');

if (video && chapters.length && list) {
  const starts = chapters.map((c) => Number(c.dataset.t));
  let current = -1;
  let pausedByUser = false;
  let pausingForView = false;

  // Beside the video the rail is as tall as the video and its chapters scroll (site.css): the one
  // playing is kept in the middle of the list. Not for a few seconds after the visitor scrolled the list
  // themselves, and a chapter they clicked is only brought fully into view. Under the video (narrow
  // screens) the list does not scroll, so nothing moves; the page itself is never scrolled.
  const HAND_SCROLL_MS = 4000;
  let handScrolledAt = -Infinity;
  let clicked = -1;
  const byHand = () => (handScrolledAt = performance.now());
  for (const type of ['wheel', 'touchmove', 'keydown']) list.addEventListener(type, byHand, { passive: true });
  // Dragging the scrollbar: the press lands on the list itself, not on a chapter.
  list.addEventListener('pointerdown', (e) => e.target === list && byHand());

  const scrollList = (top) =>
    list.scrollTo({ top: Math.max(0, top), behavior: reduceMotion.matches ? 'auto' : 'smooth' });

  const follow = (i) => {
    if (list.scrollHeight <= list.clientHeight + 1) return;
    const c = chapters[i];
    const top = c.offsetTop;
    const bottom = top + c.offsetHeight;
    if (i === clicked) {
      clicked = -1;
      const edge = 32; // the faded edge
      if (top < list.scrollTop + edge) scrollList(top - edge);
      else if (bottom > list.scrollTop + list.clientHeight - edge) scrollList(bottom - list.clientHeight + edge);
      return;
    }
    if (performance.now() - handScrolledAt < HAND_SCROLL_MS) return;
    scrollList(top - (list.clientHeight - c.offsetHeight) / 2);
  };

  // Fade the list at an edge with more chapters past it.
  const edges = () => {
    const scrolls = list.scrollHeight > list.clientHeight + 1;
    list.classList.toggle('more-above', scrolls && list.scrollTop > 1);
    list.classList.toggle('more-below', scrolls && list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  };
  list.addEventListener('scroll', edges, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(edges).observe(list);
  edges();

  const endOf = (i) => (i + 1 < starts.length ? starts[i + 1] : video.duration || starts[i] + 15);

  const render = () => {
    const t = video.currentTime;
    let i = 0;
    while (i + 1 < starts.length && t >= starts[i + 1]) i++;
    if (i !== current) {
      chapters[current]?.removeAttribute('aria-current');
      chapters[i].setAttribute('aria-current', 'true');
      current = i;
      follow(i);
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
      clicked = i;
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
