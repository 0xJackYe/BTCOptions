// Hand-built SVG: payoff chart (brush-drawn, crosshair), ensō, sparklines and
// strategy glyphs. No libraries, crisp at any DPI, CSP-safe.
import {svgEl, h, fill} from "./dom.js";
import {compact, signed, price, pct} from "./format.js";
import {reduced, EASE_INK, EASE} from "./motion.js";

function niceStep(span, count) {
  const raw = span / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}
function ticks(min, max, count) {
  const step = niceStep(max - min, count), out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf), enough for a tooltip.
function normCdf(z) {
  const t = 1 / (1 + .3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? .5 * (1 + erf) : .5 * (1 - erf);
}

let uid = 0;
let tipNode = null;
const hideChartTip = () => { tipNode?.remove(); tipNode = null; };

/**
 * Payoff chart controller. update(detail, {spot, combined}, {animate}) redraws;
 * animate=true draws the expiry line like a brush stroke (new candidate),
 * otherwise the chart refreshes silently and keeps the crosshair in place.
 */
export function createPayoffChart({height = 236} = {}) {
  const node = h("div.chart-host");
  let current = null, width = 0, pointer = null, move = null, pendingAnimate = false;
  const draw = animate => {
    if (!current || width < 10) { pendingAnimate ||= animate; return; }
    hideChartTip();
    const built = build(current.detail, {...current.options, width: Math.max(280, width), height});
    move = built.move;
    built.svg.addEventListener("pointermove", event => { pointer = {clientX: event.clientX, clientY: event.clientY}; });
    built.svg.addEventListener("pointerleave", () => { pointer = null; });
    fill(node, built.svg);
    if (animate && !reduced()) brush(built.svg);
    if (pointer) move(pointer);
  };
  const observer = new ResizeObserver(entries => {
    const next = Math.round(entries[0].contentRect.width);
    if (next > 0 && Math.abs(next - width) > 1) {
      width = next;
      const animate = pendingAnimate;
      pendingAnimate = false;
      draw(animate);
    }
  });
  observer.observe(node);
  return {
    node,
    update(detail, options, {animate = false} = {}) {
      current = {detail, options};
      if (!width) width = Math.round(node.clientWidth);
      draw(animate);
    },
    dispose() { observer.disconnect(); hideChartTip(); },
  };
}

function brush(svg) {
  const strokes = [...svg.querySelectorAll(".expiry, .combined")];
  for (const path of strokes) {
    const length = Math.ceil(path.getTotalLength());
    path.style.strokeDasharray = `${length} ${length}`;
    path.animate([{strokeDashoffset: length}, {strokeDashoffset: 0}], {duration: 1150, easing: EASE_INK, fill: "both"})
      .finished.then(() => { path.style.strokeDasharray = ""; }, () => {});
  }
  const late = svg.querySelectorAll(".gain, .loss, .density, .be, .label, .now, .spot-only");
  late.forEach(node => node.animate([{opacity: 0}, {opacity: 1}], {duration: 700, delay: 380, easing: EASE, fill: "backwards"}));
}

function build(detail, {spot, combined, width: W, height: H}) {
  const id = "pc" + (++uid);
  const m = {l: 50, r: 14, t: 18, b: 24};
  const pts = detail.curve;
  const [x0, x1] = detail.domain;
  const useCombined = combined && detail.overlay;
  const main = p => useCombined ? p.combined : p.expiry;
  const values = pts.flatMap(p => [main(p), p.now, ...(useCombined ? [p.spotOnly] : [])]).filter(Number.isFinite);
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * .1; lo -= pad; hi += pad;
  const X = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r);
  const Y = v => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
  const y0 = Y(0), bottom = H - m.b;
  const svg = svgEl("svg", {class: "payoff", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": "到期损益图：横轴为 BTC 到期结算价，纵轴为盈亏（USDT）"});
  const defs = svgEl("defs");
  defs.append(svgEl("clipPath", {id: id + "g"}));
  defs.lastChild.append(svgEl("rect", {x: 0, y: 0, width: W, height: Math.max(0, y0)}));
  defs.append(svgEl("clipPath", {id: id + "l"}));
  defs.lastChild.append(svgEl("rect", {x: 0, y: y0, width: W, height: Math.max(0, H - y0)}));
  svg.append(defs);

  for (const v of ticks(lo, hi, 5)) {
    svg.append(svgEl("line", {class: v === 0 ? "zero" : "grid-line", x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v)}));
    const label = svgEl("text", {class: "axis", x: m.l - 6, y: Y(v) + 3, "text-anchor": "end"});
    label.textContent = signed(v, Math.abs(hi - lo) < 20 ? 2 : 0).replace(/\.00$/, "");
    svg.append(label);
  }
  for (const v of ticks(x0, x1, Math.max(3, Math.floor(W / 90)))) {
    if (v <= x0 || v >= x1) continue;
    const label = svgEl("text", {class: "axis", x: X(v), y: H - 7, "text-anchor": "middle"});
    label.textContent = compact(v);
    svg.append(label);
  }

  // Model density as a soft wash along the bottom band.
  const maxDensity = Math.max(...pts.map(p => p.density || 0));
  if (maxDensity > 0) {
    const band = (H - m.t - m.b) * .24;
    let d = `M${X(pts[0].spot)},${bottom}`;
    for (const p of pts) if (!p.knot) d += `L${X(p.spot).toFixed(1)},${(bottom - (p.density / maxDensity) * band).toFixed(1)}`;
    d += `L${X(pts[pts.length - 1].spot)},${bottom}Z`;
    svg.append(svgEl("path", {class: "density", d}));
  }

  let area = `M${X(pts[0].spot)},${y0}`;
  for (const p of pts) area += `L${X(p.spot).toFixed(1)},${Y(main(p)).toFixed(1)}`;
  area += `L${X(pts[pts.length - 1].spot)},${y0}Z`;
  svg.append(svgEl("path", {class: "gain", d: area, "clip-path": `url(#${id}g)`}));
  svg.append(svgEl("path", {class: "loss", d: area, "clip-path": `url(#${id}l)`}));

  // Strike lines; labels step upward when strikes sit close together.
  let lastLabelX = -Infinity, lift = 0;
  for (const k of [...(detail.strikes ?? [])].sort((a, b) => a - b)) {
    if (k <= x0 || k >= x1) continue;
    svg.append(svgEl("line", {class: "strike", x1: X(k), x2: X(k), y1: m.t, y2: bottom}));
    lift = X(k) - lastLabelX < 52 ? lift + 13 : 0;
    lastLabelX = X(k);
    const label = svgEl("text", {class: "label", x: X(k) + 3, y: bottom - 4 - lift});
    label.textContent = "K " + compact(k);
    svg.append(label);
  }
  if (spot > x0 && spot < x1) {
    svg.append(svgEl("line", {class: "marker", x1: X(spot), x2: X(spot), y1: m.t - 6, y2: bottom}));
    const label = svgEl("text", {class: "label accent", x: X(spot), y: m.t - 8, "text-anchor": "middle"});
    label.textContent = "指数 " + price(spot);
    svg.append(label);
  }

  const line = (accessor, cls) => {
    let d = "";
    for (const p of pts) { const v = accessor(p); if (Number.isFinite(v)) d += (d ? "L" : "M") + X(p.spot).toFixed(1) + "," + Y(v).toFixed(1); }
    svg.append(svgEl("path", {class: cls, d}));
  };
  if (useCombined) line(p => p.spotOnly, "spot-only");
  line(p => p.now, "now");
  line(main, useCombined ? "combined" : "expiry");

  // Break-evens of the series actually plotted: exact roots for expiry
  // payoffs, linear interpolation for calendars and the spot overlay.
  const marks = useCombined || !(detail.breakevens?.length) ? [] : [...detail.breakevens];
  if (useCombined || !(detail.breakevens?.length)) {
    for (let i = 1; i < pts.length; i++) {
      const a = main(pts[i - 1]), b = main(pts[i]);
      if (Number.isFinite(a) && Number.isFinite(b) && (a < 0) !== (b < 0) && a !== b) marks.push(pts[i - 1].spot + (pts[i].spot - pts[i - 1].spot) * (-a) / (b - a));
    }
  }
  for (const be of marks) {
    if (be <= x0 || be >= x1) continue;
    svg.append(svgEl("circle", {class: "be", cx: X(be), cy: y0, r: 3.5}));
    const label = svgEl("text", {class: "label", x: X(be), y: y0 - 7, "text-anchor": "middle"});
    label.textContent = "BE " + compact(be);
    svg.append(label);
  }

  // Crosshair interaction.
  const cross = svgEl("line", {class: "cross", y1: m.t, y2: bottom, visibility: "hidden"});
  const dot = svgEl("circle", {class: "hover-dot", r: 4, visibility: "hidden"});
  const hit = svgEl("rect", {x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent"});
  svg.append(cross, dot, hit);
  const {sigma, years} = detail.distribution ?? {};
  const probBelow = x => sigma > 0 && years > 0 ? normCdf((Math.log(x / spot) + .5 * sigma * sigma * years) / (sigma * Math.sqrt(years))) : null;
  const move = event => {
    const box = svg.getBoundingClientRect();
    if (!box.width) return;
    const px = (event.clientX - box.left) * (W / box.width);
    const target = x0 + (px - m.l) / (W - m.l - m.r) * (x1 - x0);
    let a = 0, b = pts.length - 1;
    while (b - a > 1) { const mid = (a + b) >> 1; if (pts[mid].spot < target) a = mid; else b = mid; }
    const p = Math.abs(pts[a].spot - target) < Math.abs(pts[b].spot - target) ? pts[a] : pts[b];
    cross.setAttribute("x1", X(p.spot)); cross.setAttribute("x2", X(p.spot)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(p.spot)); dot.setAttribute("cy", Y(main(p))); dot.setAttribute("visibility", "visible");
    tipNode ??= document.body.appendChild(h("div.chart-tip", {role: "status"}));
    const rows = [["结算价", `${price(p.spot)}（${signed((p.spot / spot - 1) * 100, 1)}%）`],
      [useCombined ? "现货+期权到期" : "到期盈亏", signed(main(p), 2)], ["当前盯市", signed(p.now, 2)]];
    if (useCombined) rows.push(["仅现货", signed(p.spotOnly, 2)]);
    const below = probBelow(p.spot);
    if (below !== null) rows.push(["模型 P(低于此价)", pct(below * 100, 1)]);
    fill(tipNode, ...rows.map(([k, v]) => h("div", {}, h("span", {text: k}), h("b", {text: v}))));
    const tip = tipNode.getBoundingClientRect();
    let left = event.clientX + 14, top = event.clientY - tip.height - 10;
    if (left + tip.width > innerWidth - 8) left = event.clientX - tip.width - 14;
    if (top < 8) top = event.clientY + 16;
    tipNode.style.left = left + "px"; tipNode.style.top = top + "px";
  };
  const leave = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideChartTip(); };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave);
  return {svg, move};
}

/* ------------------------------------------------------------------- ensō */
// A calligraphic ensō: a tapered brush shape revealed by an animated mask
// stroke, so it "draws" like a single breath of ink.
const ENSO_R = 36, ENSO_FROM = -78, ENSO_SWEEP = 322;
const ensoPoint = (deg, r) => {
  const a = deg * Math.PI / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
};
const ENSO_SHAPE = (() => {
  const n = 84, outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, deg = ENSO_FROM + ENSO_SWEEP * u;
    const press = Math.min(1, u / .07) ** .6 * (1 - .72 * u ** 1.5) * (1 - .78 * Math.max(0, (u - .9) / .1));
    const width = .8 + 8.6 * press;
    const r = ENSO_R + .9 * Math.sin(u * Math.PI * 1.4) - .6 * u;
    outer.push(ensoPoint(deg, r + width / 2));
    inner.push(ensoPoint(deg, r - width / 2));
  }
  const pts = [...outer, ...inner.reverse()];
  return "M" + pts.map(([x, y]) => x.toFixed(2) + " " + y.toFixed(2)).join("L") + "Z";
})();
const ENSO_GUIDE = (() => {
  const [sx, sy] = ensoPoint(ENSO_FROM, ENSO_R), [ex, ey] = ensoPoint(ENSO_FROM + ENSO_SWEEP, ENSO_R - .6);
  return `M${sx.toFixed(2)} ${sy.toFixed(2)}A${ENSO_R} ${ENSO_R} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
})();

export function enso({loop = true, label = null} = {}) {
  const id = "enso" + (++uid);
  const svg = svgEl("svg", {class: "enso" + (loop ? " loop" : ""), viewBox: "0 0 100 100", role: label ? "img" : null,
    "aria-label": label, "aria-hidden": label ? null : "true"});
  const defs = svgEl("defs"), mask = svgEl("mask", {id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 100, height: 100});
  mask.append(svgEl("path", {class: "brush", d: ENSO_GUIDE, pathLength: 240, fill: "none", stroke: "#fff", "stroke-width": 15, "stroke-linecap": "round"}));
  defs.append(mask);
  svg.append(defs, svgEl("path", {class: "ink", d: ENSO_SHAPE, fill: "currentColor", mask: `url(#${id})`}));
  return svg;
}

/* -------------------------------------------------------------- sparkline */
/** ATM IV term structure sparkline (x on √DTE so near expiries stay readable). */
export function termSparkline(term, {width = 132, height = 30} = {}) {
  const points = (term ?? []).filter(p => p.atmIv > 0 && p.dte >= .5);
  const svg = svgEl("svg", {class: "spark", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true"});
  if (points.length < 2) return svg;
  const xs = points.map(p => Math.sqrt(p.dte)), ys = points.map(p => p.atmIv);
  const [xMin, xMax] = [Math.min(...xs), Math.max(...xs)], [yMin, yMax] = [Math.min(...ys), Math.max(...ys)];
  const X = v => 3 + (v - xMin) / (xMax - xMin || 1) * (width - 6);
  const Y = v => height - 4 - (v - yMin) / (yMax - yMin || 1) * (height - 8);
  let d = "";
  points.forEach((p, i) => { d += (i ? "L" : "M") + X(xs[i]).toFixed(1) + "," + Y(ys[i]).toFixed(1); });
  svg.append(svgEl("path", {class: "area", d: d + `L${X(xs.at(-1))},${height}L${X(xs[0])},${height}Z`}));
  svg.append(svgEl("path", {class: "line", d}));
  points.forEach((p, i) => svg.append(svgEl("circle", {cx: X(xs[i]), cy: Y(ys[i]), r: 1.8})));
  return svg;
}

const GLYPHS = {
  "crash-put": "M2 16 L9 6 L18 6", "income-put": "M2 16 L9 6 L18 6", "vrp-put": "M2 16 L9 6 L18 6", "short-put": "M2 16 L10 6 L18 6",
  "bull-put": "M2 15 L6 15 L11 6 L18 6", "budget-put": "M2 15 L6 15 L11 6 L18 6", "protective-put": "M2 12 L9 12 L18 4",
  "short-call": "M2 6 L11 6 L18 16", "covered-call": "M2 16 L11 6 L18 6", "long-straddle": "M2 4 L10 15 L18 4",
  "long-strangle": "M2 4 L7 14 L13 14 L18 4", "bear-call": "M2 6 L9 6 L14 15 L18 15", "bull-call": "M2 15 L7 15 L12 6 L18 6",
  "calendar": "M2 14 C7 14 8 4 10 4 C12 4 13 14 18 14", "put-ratio": "M2 17 L7 7 L11 12 L18 12", "long-call": "M2 14 L11 14 L18 4",
  "long-put": "M2 4 L9 14 L18 14",
};
export function strategyGlyph(id) {
  const svg = svgEl("svg", {class: "glyph", viewBox: "0 0 20 20", "aria-hidden": "true"});
  svg.append(svgEl("path", {d: "M1 10.5H19", stroke: "currentColor", "stroke-opacity": ".25", "stroke-width": "1", fill: "none"}));
  svg.append(svgEl("path", {d: GLYPHS[id] ?? "M2 10 L18 10", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round"}));
  return svg;
}

/** Inline proportion bar used in tables. */
export function bar(fraction, tone = "") {
  const node = h("div.meter" + (tone ? "." + tone : ""));
  node.append(h("i"));
  node.style.setProperty("--w", Math.max(0, Math.min(100, fraction * 100)).toFixed(1) + "%");
  return node;
}
