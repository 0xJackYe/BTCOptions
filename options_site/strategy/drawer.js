// The detail sheet below 1500 px: it slides in on a spring, follows the
// finger (or mouse) when dragged sideways, and a release either springs it
// back or flings it away with the hand's own velocity. Vertical scrolling
// inside it stays native (touch-action: pan-y).
import {springTo, follow, reduced} from "./motion.js";

const SKIP = "svg.payoff, input, select, textarea, button, a, .stepper, .seg, .tabs, [data-nodrag]";
const render = v => `translateX(${v.x}px)`;

export function createDrawer({panel, desk, query, onClosed}) {
  let open = false, scrim = null;
  const width = () => panel.getBoundingClientRect().width || innerWidth;
  const enabled = () => query.matches;

  function fadeScrim(to, duration) {
    if (!scrim) return;
    const from = Number(getComputedStyle(scrim).opacity);
    scrim.style.opacity = String(to);
    if (!reduced()) scrim.animate([{opacity: from}, {opacity: to}], {duration, easing: "cubic-bezier(.2,.8,.2,1)"});
  }

  function show({velocity = 0} = {}) {
    if (!enabled()) return;
    if (!open) {
      open = true;
      desk.classList.add("detail-open");
      if (!panel.__spring) panel.__spring = {x: width()};
      scrim ??= document.body.appendChild(Object.assign(document.createElement("div"), {className: "scrim"}));
      scrim.style.opacity = "0";
      scrim.onclick = () => hide();
      fadeScrim(1, 280);
    }
    springTo(panel, {x: 0}, render, {preset: "sheet", velocity: {x: velocity}});
  }

  function hide({velocity = 0} = {}) {
    if (!open) return;
    open = false;
    const anim = springTo(panel, {x: width() + 24}, render, {preset: "sheet", velocity: {x: velocity}});
    fadeScrim(0, 240);
    const done = () => {
      if (open) return;
      desk.classList.remove("detail-open");
      scrim?.remove();
      scrim = null;
      onClosed?.();
    };
    if (anim) anim.finished.then(done, () => {}); else done();
  }

  // Drag to dismiss, with a velocity-carrying release.
  let drag = null;
  panel.addEventListener("pointerdown", event => {
    if (!open || !enabled() || event.button > 0 || event.target.closest(SKIP)) return;
    drag = {id: event.pointerId, x0: event.clientX, y0: event.clientY, active: false, trail: [[event.timeStamp, event.clientX]]};
  });
  panel.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x0, dy = event.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // a scroll, not a swipe
      if (Math.abs(dx) < 8) return;
      drag.active = true;
      panel.setPointerCapture(event.pointerId);
      panel.classList.add("dragging");
    }
    // Free to the right, rubber-banded to the left.
    const x = dx >= 0 ? dx : -Math.sqrt(-dx) * 4;
    follow(panel, {x}, render);
    if (scrim) scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, x) / width()));
    drag.trail.push([event.timeStamp, event.clientX]);
    if (drag.trail.length > 6) drag.trail.shift();
  });
  const release = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const state = drag;
    drag = null;
    if (!state.active) return;
    panel.classList.remove("dragging");
    const [t0, x0] = state.trail[0], [t1, x1] = state.trail.at(-1);
    const velocity = t1 > t0 ? (x1 - x0) / (t1 - t0) * 1000 : 0;          // px per second
    const travelled = event.clientX - state.x0;
    if (travelled > width() * .33 || velocity > 650) hide({velocity});
    else {
      springTo(panel, {x: 0}, render, {preset: "sheet", velocity: {x: velocity}});
      fadeScrim(1, 200);
    }
  };
  panel.addEventListener("pointerup", release);
  panel.addEventListener("pointercancel", release);

  // Leaving drawer mode (window widened) resets everything.
  query.addEventListener("change", () => {
    if (!query.matches) {
      open = false;
      desk.classList.remove("detail-open");
      scrim?.remove();
      scrim = null;
      panel.__spring = null;
      panel.style.transform = "";
    } else {
      panel.__spring = {x: width() + 24};
      panel.style.transform = render(panel.__spring);
    }
  });
  if (enabled()) { panel.__spring = {x: width() + 24}; panel.style.transform = render(panel.__spring); }

  return {show, hide, get open() { return open; }};
}
