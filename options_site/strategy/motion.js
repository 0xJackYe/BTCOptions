// Motion system. Rules it follows everywhere:
//  • only transform and opacity move, so the compositor runs every frame;
//  • springs are simulated here and handed to the compositor as keyframes,
//    and an interrupted spring continues from its current position *and
//    velocity* (no jumps, no restarts);
//  • frequent actions stay short (≈ 0.2–0.4 s); nothing waits on data;
//  • prefers-reduced-motion turns every helper into an instant change.
const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reduced = () => Boolean(query?.matches);
export const EASE = "cubic-bezier(.2, .8, .2, 1)";
export const EASE_INK = "cubic-bezier(.3, .7, .1, 1)";

/* ---------------------------------------------------------------- springs */
const SPRINGS = {
  // ζ ≈ 0.9: settles in ~0.25 s with the faintest overshoot.
  snappy: {stiffness: 460, damping: 38},
  // ζ ≈ 1: sheets and drawers, no overshoot.
  sheet: {stiffness: 320, damping: 36},
};
const active = new WeakMap();

function simulate(from, to, velocity, {stiffness, damping}) {
  const keys = Object.keys(to), dt = 1 / 240, samples = [{...from}], speeds = [{...velocity}];
  const x = {...from}, v = {...velocity};
  for (let step = 1; step <= 240 * 1.6; step++) {
    let settled = true;
    for (const k of keys) {
      const force = -stiffness * (x[k] - to[k]) - damping * v[k];
      v[k] += force * dt;
      x[k] += v[k] * dt;
      if (Math.abs(x[k] - to[k]) > Math.max(.02, Math.abs(to[k]) * 1e-4) || Math.abs(v[k]) > .05) settled = false;
    }
    if (step % 4 === 0 || settled) { samples.push({...x}); speeds.push({...v}); }
    if (settled) break;
  }
  samples[samples.length - 1] = {...to};
  return {samples, speeds, duration: (samples.length - 1) * 4 / 240 * 1000};
}

/**
 * Springs element channels (e.g. {x, w}) to `to`; render(values) builds the
 * transform. Runs as a compositor animation; interrupting it carries over
 * the current position and velocity. `velocity` (units/s) seeds a fling.
 */
export function springTo(el, to, render, {preset = "snappy", velocity = null, instant = false} = {}) {
  if (!el) return;
  const prev = active.get(el);
  let from = el.__spring ?? null, speed = {};
  if (prev) {
    const t = Math.max(0, Math.min(prev.duration, Number(prev.anim.currentTime) || 0));
    const i = Math.min(prev.samples.length - 1, t / prev.duration * (prev.samples.length - 1));
    const lo = Math.floor(i), hi = Math.min(prev.samples.length - 1, lo + 1), f = i - lo;
    from = {}; speed = {};
    for (const k of Object.keys(prev.to)) {
      from[k] = prev.samples[lo][k] + (prev.samples[hi][k] - prev.samples[lo][k]) * f;
      speed[k] = prev.speeds[lo][k] + (prev.speeds[hi][k] - prev.speeds[lo][k]) * f;
    }
    prev.anim.cancel();
    active.delete(el);
  }
  el.__spring = {...to};
  el.style.transform = render(to);
  if (instant || reduced() || !from) return;
  for (const k of Object.keys(to)) {
    if (!Number.isFinite(from[k])) from[k] = to[k];
    speed[k] = velocity?.[k] ?? speed[k] ?? 0;
  }
  if (Object.keys(to).every(k => Math.abs(from[k] - to[k]) < .01 && Math.abs(speed[k]) < .05)) return;
  const {samples, speeds, duration} = simulate(from, to, speed, SPRINGS[preset] ?? SPRINGS.snappy);
  const anim = el.animate(samples.map(values => ({transform: render(values)})), {duration, easing: "linear"});
  const entry = {anim, samples, speeds, duration, to: {...to}};
  active.set(el, entry);
  anim.finished.then(() => { if (active.get(el) === entry) active.delete(el); }, () => {});
  return anim;
}
/** Where a spring-driven element is right now (mid-flight included). */
export function springValue(el) {
  const prev = active.get(el);
  if (!prev) return el.__spring ?? null;
  const t = Math.max(0, Math.min(prev.duration, Number(prev.anim.currentTime) || 0));
  return prev.samples[Math.round(t / prev.duration * (prev.samples.length - 1))] ?? prev.to;
}
/** Holds an element where the finger is (cancels any spring on it). */
export function follow(el, values, render) {
  active.get(el)?.anim.cancel();
  active.delete(el);
  el.__spring = {...values};
  el.style.transform = render(values);
}

/** Rail / tab ink: springs to the target element (translate + scale). */
export function placeInk(ink, target, {axis = "y", instant = false} = {}) {
  if (!ink) return;
  if (!target || !target.offsetParent) { ink.style.opacity = "0"; return; }
  ink.style.opacity = "1";
  const first = !ink.__spring;
  if (axis === "y") {
    springTo(ink, {y: target.offsetTop, h: target.offsetHeight}, v => `translateY(${v.y}px) scaleY(${v.h})`, {instant: instant || first});
  } else {
    springTo(ink, {x: target.offsetLeft, w: target.offsetWidth}, v => `translateX(${v.x}px) scaleX(${v.w})`, {instant: instant || first});
  }
}

/* ------------------------------------------------------------ entrances */
/** Odometer digits: only the characters that changed roll to their new value. */
export function ticker(node, text) {
  text = String(text);
  if (node.dataset.value === text) return;
  const previous = node.dataset.value ?? "";
  node.dataset.value = text;
  node.setAttribute("aria-label", text);
  const shape = value => value.replace(/\d/g, "0");
  if (!node.firstChild || shape(previous) !== shape(text)) {
    node.replaceChildren(...[...text].map(ch => {
      if (!/\d/.test(ch)) {
        const plain = document.createElement("span");
        plain.textContent = ch;
        plain.setAttribute("aria-hidden", "true");
        return plain;
      }
      const col = document.createElement("span");
      col.className = "col";
      col.setAttribute("aria-hidden", "true");
      const reel = document.createElement("span");
      reel.className = "reel";
      for (let d = 0; d <= 9; d++) {
        const digit = document.createElement("span");
        digit.textContent = String(d);
        reel.append(digit);
      }
      reel.style.transform = `translateY(${-Number(ch)}em)`;
      col.append(reel);
      return col;
    }));
    return;
  }
  [...text].forEach((ch, i) => {
    if (/\d/.test(ch) && ch !== previous[i]) node.children[i].firstChild.style.transform = `translateY(${-Number(ch)}em)`;
  });
}

/** FLIP: animate elements from where they were to where mutate() put them. */
export function flip(elements, mutate, {duration = 360} = {}) {
  if (reduced() || !elements.length) { mutate(); return; }
  const before = new Map(elements.map(el => [el, el.getBoundingClientRect().top]));
  mutate();
  for (const [el, top] of before) {
    if (!el.isConnected) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1 && Math.abs(dy) < innerHeight * 1.5) {
      el.animate([{transform: `translateY(${dy}px)`}, {transform: "none"}], {duration, easing: EASE});
    }
  }
}

/** Staggered entrance for fresh content: opacity and a few pixels of rise. */
export function inkIn(nodes, {step = 18, max = 10, distance = 4, duration = 260, from = 0} = {}) {
  if (reduced()) return;
  [...nodes].slice(0, max).forEach((node, i) => {
    node.animate([{opacity: from, transform: `translateY(${distance}px)`}, {opacity: 1, transform: "none"}],
      {duration, delay: i * step, easing: EASE, fill: "backwards"});
  });
}

/** A hanko stamp landing: over-scale, slight rotation, settle. */
export function stamp(node) {
  if (reduced() || !node) return;
  node.animate([{opacity: 0, transform: "scale(1.7) rotate(-12deg)"}, {opacity: 1, offset: .5}, {opacity: 1, transform: "scale(1) rotate(-4deg)"}],
    {duration: 380, easing: "cubic-bezier(.3, 1.4, .5, 1)", fill: "backwards"});
}

/**
 * Ink drop for the theme switch, compositor-only: a small disc of the new
 * paper colour scales up from the button until it covers the page, the
 * theme changes underneath, and the veil dissolves. Its soft, slightly
 * blurred edge (a scaled-up raster) reads as ink bleeding into washi.
 */
export function inkVeil(apply, {x, y, color}) {
  if (reduced()) { apply(); return; }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 8;
  const size = 48;
  const veil = document.createElement("div");
  veil.className = "ink-veil";
  Object.assign(veil.style, {left: x - size / 2 + "px", top: y - size / 2 + "px", width: size + "px", height: size + "px", background: color});
  document.body.append(veil);
  const scale = radius * 2 / size;
  veil.animate([{transform: "scale(.2)"}, {transform: `scale(${scale})`}], {duration: 380, easing: EASE_INK, fill: "forwards"})
    .finished.then(() => {
      apply();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        veil.animate([{opacity: 1}, {opacity: 0}], {duration: 240, easing: "ease-out", fill: "forwards"})
          .finished.then(() => veil.remove(), () => veil.remove());
      }));
    }, () => { apply(); veil.remove(); });
}
