// Motion system: calm, brush-like and interruptible. Every helper degrades to
// an instant state change under prefers-reduced-motion.
const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reduced = () => Boolean(query?.matches);
export const EASE = "cubic-bezier(.16, 1, .3, 1)";
export const EASE_INK = "cubic-bezier(.22, .8, .2, 1)";

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
export function flip(elements, mutate, {duration = 520} = {}) {
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

/** Staggered ink-in for freshly inserted nodes. */
export function inkIn(nodes, {step = 28, max = 18, distance = 6, blur = true} = {}) {
  if (reduced()) return;
  [...nodes].slice(0, max).forEach((node, i) => {
    node.animate([{opacity: 0, transform: `translateY(${distance}px)`, ...(blur ? {filter: "blur(3px)"} : {})},
      {opacity: 1, transform: "none", ...(blur ? {filter: "blur(0)"} : {})}], {duration: 460, delay: i * step, easing: EASE, fill: "backwards"});
  });
}

/** A hanko stamp landing: over-scale, slight rotation, settle. */
export function stamp(node) {
  if (reduced() || !node) return;
  node.animate([{opacity: 0, transform: "scale(1.9) rotate(-14deg)"}, {opacity: 1, offset: .55}, {opacity: 1, transform: "scale(1) rotate(-4deg)"}],
    {duration: 560, easing: "cubic-bezier(.3, 1.45, .45, 1)", fill: "backwards"});
}

/** Moves an indicator (rail / tab ink) to a target element, springing. */
export function placeInk(ink, target, {axis = "y", instant = false} = {}) {
  if (!ink) return;
  if (!target) { ink.style.opacity = "0"; return; }
  const restore = instant || reduced() ? ink.style.transition : null;
  if (restore !== null) ink.style.transition = "none";
  if (axis === "y") {
    ink.style.height = target.offsetHeight + "px";
    ink.style.transform = `translateY(${target.offsetTop}px)`;
  } else {
    ink.style.width = target.offsetWidth + "px";
    ink.style.transform = `translateX(${target.offsetLeft}px)`;
  }
  ink.style.opacity = "1";
  if (restore !== null) { void ink.offsetWidth; ink.style.transition = restore; }
}

/** Runs update inside a View Transition when supported (and motion allowed). */
export function viewTransition(update, {className = null} = {}) {
  if (reduced() || typeof document.startViewTransition !== "function") {
    const result = update();
    return {finished: Promise.resolve(result), ready: Promise.resolve()};
  }
  const root = document.documentElement;
  if (className) root.classList.add(className);
  let transition;
  try {
    transition = document.startViewTransition(update);
  } catch {
    if (className) root.classList.remove(className);
    const result = update();
    return {finished: Promise.resolve(result), ready: Promise.resolve()};
  }
  transition.finished.finally(() => { if (className) root.classList.remove(className); }).catch(() => {});
  transition.ready.catch(() => {});
  return transition;
}

/** Ink drop: reveals the new theme as a circle spreading from a point. */
export function inkDrop(apply, origin) {
  const x = origin?.x ?? innerWidth - 60, y = origin?.y ?? 28;
  const transition = viewTransition(apply, {className: "vt-theme"});
  if (!transition.ready || reduced() || typeof document.startViewTransition !== "function") return;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  transition.ready.then(() => {
    document.documentElement.animate({clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]},
      {duration: 680, easing: EASE_INK, pseudoElement: "::view-transition-new(root)"});
  }, () => {});
}
