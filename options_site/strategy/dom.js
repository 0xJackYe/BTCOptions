// Minimal DOM helpers. Text is always set through textContent or escaped.
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Hyperscript: h("button.btn.primary", {onClick, "aria-label": "…"}, child, …). */
export function h(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const element = document.createElement(tag || "div");
  if (classes.length) element.className = classes.join(" ");
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = [element.className, value].filter(Boolean).join(" ");
    else if (key === "text") element.textContent = value;
    else if (key === "style") for (const [name, v] of Object.entries(value)) element.style.setProperty(name, v);
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

/** replaceChildren that drops null / false / undefined (never renders "null"). */
export function fill(parent, ...children) {
  parent.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    .map(child => child instanceof Node ? child : document.createTextNode(String(child))));
  return parent;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function icon(name, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "i" + (className ? " " + className : ""));
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

export function svgEl(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  return element;
}

export const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch]);

/** Event delegation: on(root, "click", "[data-x]", (event, match) => …). */
export function on(root, type, selector, handler, options) {
  root.addEventListener(type, event => {
    const match = event.target instanceof Element ? event.target.closest(selector) : null;
    if (match && root.contains(match)) handler(event, match);
  }, options);
}

export const isTyping = event => {
  const target = event.target;
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
};
