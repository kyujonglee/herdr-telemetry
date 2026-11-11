// Cockpit's drawing kit: the HUD palette, type, panel frames, collapsing and
// the motion switch, shared by every role of the cockpit mod.

import { div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, run, shared, setShared, window as appWindow } from "herdr";

export const ASSETS = "mods/cockpit";
export const HUD = "Rajdhani";
export const MONO = "IBM Plex Mono";

export const C = {
  bg: "#07080a",
  panel: "#0a0b0dcc",
  amber: "#ffb547",
  amberHi: "#ffd28a",
  amberLine: "#ffb54733",
  amberFaint: "#ffb5471f",
  cyan: "#5ce1e6",
  cyanHi: "#c9f6f8",
  cyanFaint: "#5ce1e61a",
  red: "#ff5b3a",
  redHi: "#ffd9cf",
  redSoft: "#ffb3a3",
  green: "#9be59b",
  ink: "#f4efe4",
  text: "#d8d0c0",
  muted: "#a39b8b",
  dim: "#958d7f", // the dimmest color text uses
  faint: "#6e685d", // rules and decoration only
  cryo: "#6f7f99",
  cryoHi: "#8e9bb3",
};

// Agent status → HUD color and word.
export const STATUS = {
  blocked: { c: C.red, word: "INPUT" },
  done: { c: C.green, word: "DONE" },
  working: { c: C.cyan, word: "WORK" },
  idle: { c: C.muted, word: "IDLE" },
  cryo: { c: C.cryo, word: "CRYO" },
};
export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// Rajdhani has no letter-spacing control here: hair spaces stand in for tracking.
// Hangul keeps its own spacing.
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
export const track = (s) => (HANGUL.test(String(s ?? "")) ? String(s ?? "") : [...String(s ?? "").toUpperCase()].join("\u200a"));

/** A small uppercase HUD label. */
export function label(text, color = C.muted, size = 11.5) {
  return div().font_family(HUD).font_weight(600).text_size(size).text_color(color).whitespace_nowrap().child(track(text));
}

/** Monospace figures. */
export function mono(text, color = C.text, size = 11) {
  return div().font_family(MONO).text_size(size).text_color(color).whitespace_nowrap().child(String(text ?? ""));
}

export function icon(name, size = 12, color = C.muted) {
  return svg(`${ASSETS}/icons/${name}.svg`).size(size).flex_none().text_color(color);
}

// ---- motion: one switch for every loop, spin and frame strip

// Motion runs only while the window is in front: a cockpit in the background stays still.
export const motionSetting = () => shared("cockpit.motion") !== false;
export const motionOn = () => motionSetting() && appWindow()?.active !== false;
/** Applies `fn` (a .loop / .spin / .frames) only while motion is on. */
export const move = (el, fn) => (motionOn() ? fn(el) : el);
export const blink = (el, period = 1400) => move(el, (e) => e.loop("opacity", { from: 0.45, to: 1, period }));

// ---- painted layers

const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();

/** A layer filling its relative parent with a gradient. */
export function gradient(from, to, angle = 180) {
  return window.paint_path(RECT(), Background.linear_gradient(angle, from, to)).absolute().top(0).left(0).size_full();
}

/** A layer filling its relative parent with diagonal stripes. */
export function stripes(color, width = 5, interval = 11) {
  return window.paint_path(RECT(), Background.pattern_slash(color, width, interval)).absolute().top(0).left(0).size_full();
}

// ---- layout nodes

export function parentOf(node, id) {
  for (const child of node?.children ?? []) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}

export function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export const STRIP = 30;
export const isCollapsed = (id) => {
  const px = find(layout(), id)?.size?.px;
  return typeof px === "number" && px <= STRIP + 2;
};
export const isHidden = (id) => Boolean(find(layout(), id)?.hidden);

const sizeOf = (n) => (typeof n?.size?.px === "number" ? { px: n.size.px } : { weight: n?.size?.weight ?? 1 });

/**
 * Folds a panel's block to its title strip, or back to the size it had. When the
 * fold leaves no stretchy sibling, an open sibling stretches into the space (and
 * gets its own size back on unfold), so a column never ends in a blank hole.
 */
export function toggleCollapse(id, open) {
  const root = layout();
  const node = find(root, id);
  if (!node) return;
  const key = `cockpit.size.${id}`;
  const lentKey = `cockpit.lent.${id}`;
  if (isCollapsed(id)) {
    run("layout.resize", { id, ...(shared(key) ?? open ?? { weight: 1 }) });
    const lent = shared(lentKey);
    if (lent?.id && find(root, lent.id)) run("layout.resize", { id: lent.id, ...lent.size });
    setShared(lentKey, null);
  } else {
    setShared(key, sizeOf(node));
    run("layout.resize", { id, px: STRIP });
    const open = (parentOf(root, id)?.children ?? []).filter((c) => c.id !== id && !c.hidden && !isCollapsed(c.id));
    if (open.length && !open.some((c) => typeof c.size?.px !== "number")) {
      const sib = open[open.length - 1];
      setShared(lentKey, { id: sib.id, size: sizeOf(sib) });
      run("layout.resize", { id: sib.id, weight: 1 });
    }
  }
}

/**
 * A HUD panel: a thin amber frame with a title strip. Clicking the strip folds
 * the panel's layout block to the strip. `block` is the layout node id.
 */
export function panel({ block, open, title, code, right, summary, body, accent = C.amberLine }) {
  const folded = block ? isCollapsed(block) : false;
  const strip = h_flex()
    .id(`strip-${block ?? title}`)
    .h(STRIP - 2)
    .flex_none()
    .px(10)
    .gap(8)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(C.amberFaint))
    .when(Boolean(block), (el) => el.on_click(() => toggleCollapse(block, open)))
    .child(div().w(6).h(6).flex_none().bg(folded ? C.dim : C.amber))
    .child(label(title, folded ? C.muted : C.ink, 12.5))
    // Folded with a summary: the summary needs the room more than the code name.
    .when(Boolean(code) && !(folded && summary != null), (el) => el.child(label(code, C.faint, 9.5)))
    .child(div().flex_1().min_w(0))
    .when(!folded && right != null, (el) => el.child(typeof right === "string" ? label(right) : right))
    .when(folded && summary != null, (el) => el.child(typeof summary === "string" ? div().font_family(MONO).text_size(10).text_color(C.muted).min_w(0).truncate().child(summary) : summary))
    .when(Boolean(block), (el) => el.tooltip(folded ? "Expand" : "Collapse").child(icon(folded ? "chev-down" : "chev-up", 11, C.dim)));
  return v_flex()
    .size_full()
    .relative()
    .overflow_hidden()
    .bg(C.panel)
    .border(1)
    .border_color(accent)
    .child(strip)
    .when(!folded, (el) => el.child(div().h(1).w_full().flex_none().bg(C.amberFaint)).child(v_flex().flex_1().min_h(0).w_full().child(body())));
}

// ---- agents

/** An agent's own name for its task (Claude Code titles its terminal), else its tab's name. */
export function agentTitle(a) {
  const t = String(a?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const prog = a?.program?.name ?? "";
  const telling = t && t !== prog && t.toLowerCase() !== a?.program?.key && !/^[~/]/.test(t) && !t.includes("@");
  if (telling) return t;
  // A bare tab number ("1") says nothing: name the program, and the machine when remote.
  const machine = String(a?.address ?? "").includes("/") ? String(a.address).split("/")[0] : null;
  const tab = a?.tab_name && !/^(tab\s*)?\d+$/i.test(a.tab_name) ? a.tab_name : null;
  return tab ?? `${prog || "agent"}${machine ? ` @ ${machine}` : ""}`;
}

/** Where an agent is: space · tab · program, leaving out repeats. */
export function agentWhere(a) {
  const parts = [a?.space_name];
  if (a?.tab_name && a.tab_name !== agentTitle(a)) parts.push(/^\d+$/.test(a.tab_name) ? `tab ${a.tab_name}` : a.tab_name);
  if (a?.program?.name && !parts.includes(a.program.name)) parts.push(a.program.name);
  return parts.filter(Boolean).join(" · ");
}

// ---- time

export function ago(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Time left as 48m, 1h48, 3d4h. */
export function left(ms) {
  if (!(ms > 0)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export const shortName = (s, n = 3) => String(s ?? "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, n).toUpperCase() || "—";

export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}
