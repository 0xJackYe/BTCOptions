// UI primitives: tooltips, toasts, anchored popovers, dialogs, clipboard.
import {h, icon} from "./dom.js";

/* ----------------------------------------------------------------- tooltip */
let tipEl = null, tipFor = null, tipTimer = 0;

function showTip(target) {
  const text = target.getAttribute("data-tip");
  if (!text) return;
  hideTip();
  const [title, ...rest] = text.split("|");
  tipEl = h("div.tip", {role: "tooltip"}, rest.length ? [h("b", {text: title}), rest.join("|")] : title);
  document.body.append(tipEl);
  const box = target.getBoundingClientRect(), tip = tipEl.getBoundingClientRect();
  let top = box.bottom + 8, left = box.left + box.width / 2 - tip.width / 2;
  if (top + tip.height > innerHeight - 8) top = box.top - tip.height - 8;
  left = Math.max(8, Math.min(innerWidth - tip.width - 8, left));
  tipEl.style.top = top + "px";
  tipEl.style.left = left + "px";
  tipFor = target;
}

export function hideTip() {
  clearTimeout(tipTimer);
  tipEl?.remove();
  tipEl = null; tipFor = null;
}

export function installTooltips() {
  document.addEventListener("pointerover", event => {
    if (event.pointerType === "touch") return;     // a tap is not a hover
    const target = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
    if (target === tipFor) return;
    clearTimeout(tipTimer);
    if (!target) { hideTip(); return; }
    tipTimer = setTimeout(() => showTip(target), 260);
  });
  document.addEventListener("focusin", event => {
    const target = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
    if (target && target.matches(":focus-visible")) showTip(target); else hideTip();
  });
  for (const type of ["pointerdown", "scroll", "keydown"]) document.addEventListener(type, hideTip, true);
}

/* ------------------------------------------------------------------ toasts */
const ICONS = {ok: "✓", err: "!", warn: "!", info: "i"};
export function toast(kind, title, body = "", {timeout = 4200} = {}) {
  const host = document.getElementById("toasts");
  if (!host) return;
  let timer = 0, remaining = timeout, startedAt = 0, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    node.classList.add("out");
    node.addEventListener("animationend", () => node.remove(), {once: true});
    setTimeout(() => node.remove(), 400);
  };
  const life = timeout ? h("i.life", {style: {"animation-duration": timeout + "ms"}}) : null;
  const node = h("div.toast." + kind, {role: kind === "err" ? "alert" : "status"},
    h("span.ic", {text: ICONS[kind] ?? "i"}),
    h("div", {}, h("strong", {text: title}), body ? h("p", {text: body}) : null),
    h("button", {type: "button", "aria-label": "关闭提示", onClick: close}, icon("close")), life);
  const run = () => { startedAt = Date.now(); timer = setTimeout(close, remaining); };
  // Hovering holds the toast (and its life line) so it can be read in full.
  node.addEventListener("pointerenter", () => {
    if (!timeout || closed) return;
    clearTimeout(timer);
    remaining = Math.max(600, remaining - (Date.now() - startedAt));
    life.style.animationPlayState = "paused";
  });
  node.addEventListener("pointerleave", () => {
    if (!timeout || closed) return;
    life.style.animationPlayState = "running";
    run();
  });
  host.append(node);
  while (host.children.length > 4) host.firstElementChild.remove();
  if (timeout) run();
}

/* ---------------------------------------------------------------- popovers */
let activePopover = null;

export function closePopover() {
  if (!activePopover) return;
  const {element, anchor, onClose, cleanup} = activePopover;
  activePopover = null;
  cleanup();
  element.remove();
  anchor?.setAttribute("aria-expanded", "false");
  onClose?.();
}

export function openPopover(anchor, content, {onClose, label = "编辑"} = {}) {
  closePopover();
  const element = h("div.popover", {role: "dialog", "aria-label": label}, content);
  document.body.append(element);
  const place = () => {
    const box = anchor.getBoundingClientRect(), pop = element.getBoundingClientRect();
    let top = box.bottom + 6, left = box.left;
    if (top + pop.height > innerHeight - 10) top = Math.max(10, box.top - pop.height - 6);
    left = Math.max(10, Math.min(innerWidth - pop.width - 10, left));
    element.style.top = top + "px";
    element.style.left = left + "px";
  };
  place();
  anchor.setAttribute("aria-expanded", "true");
  const outside = event => { if (!element.contains(event.target) && !anchor.contains(event.target)) closePopover(); };
  const key = event => { if (event.key === "Escape") { event.stopPropagation(); closePopover(); anchor.focus(); } };
  const reflow = () => place();
  document.addEventListener("pointerdown", outside, true);
  element.addEventListener("keydown", key);
  addEventListener("resize", reflow);
  activePopover = {element, anchor, onClose, cleanup: () => {
    document.removeEventListener("pointerdown", outside, true);
    removeEventListener("resize", reflow);
  }};
  requestAnimationFrame(() => element.querySelector("input, button, select")?.focus());
  return element;
}

export const popoverOpen = () => Boolean(activePopover);

/* ----------------------------------------------------------------- dialogs */
/** Closes with an exit animation; Esc and backdrop clicks go through here too. */
const closing = new WeakMap();
export function closeDialog(dialog) {
  if (!dialog?.open || closing.has(dialog)) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { dialog.close(); return; }
  let timer = 0;
  const finish = event => {
    if (event && event.target !== dialog) return;   // a descendant's animation ended
    if (closing.get(dialog) !== finish) return;
    closing.delete(dialog);
    clearTimeout(timer);
    dialog.removeEventListener("animationend", finish);
    dialog.classList.remove("closing");
    if (dialog.open) dialog.close();
  };
  closing.set(dialog, finish);
  dialog.classList.add("closing");
  dialog.addEventListener("animationend", finish);
  timer = setTimeout(finish, 260);
}

export function openDialog(dialog) {
  if (!dialog.dataset.wired) {
    dialog.dataset.wired = "1";
    dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(dialog); });
    dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(dialog); });
  }
  closing.get(dialog)?.();              // reopening mid-exit: finish the exit first
  if (!dialog.open) dialog.showModal();
}

export function dialogFrame(title, subtitle, body, footer = null) {
  const id = title.replace(/\s+/g, "") + "Title";
  return [
    h("div.dialog-head", {}, h("div", {}, h("h2", {id, text: title}), subtitle ? h("p", {text: subtitle}) : null),
      h("button.icon-btn", {type: "button", "aria-label": "关闭", onClick: event => closeDialog(event.currentTarget.closest("dialog"))}, icon("close"))),
    h("div.dialog-body", {}, body),
    footer ? h("div.dialog-foot", {}, footer) : null,
  ];
}

/* --------------------------------------------------------------- clipboard */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", {readonly: true, class: "sr-only"});
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

export function download(filename, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = h("a", {href: url, download: filename});
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ----------------------------------------------------------------- storage */
export function load(key, fallback) {
  try {
    const raw = localStorage.getItem("btcdesk:" + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem("btcdesk:" + key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function loadSession(key) {
  try { return sessionStorage.getItem("btcdesk:" + key); } catch { return null; }
}

export function saveSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem("btcdesk:" + key);
    else sessionStorage.setItem("btcdesk:" + key, value);
  } catch { /* private mode */ }
}
