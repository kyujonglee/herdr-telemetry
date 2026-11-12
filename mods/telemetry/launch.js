// The + menu over the tabs: a terminal or an agent (Claude Code, Codex, Grok, …) in a
// folder you pick. Folders offered: the focused terminal's (picked at first), the ones
// this menu started things in before (on that machine, most used first), and where
// the space's machine has terminals open now. Also New space and the worktree entries
// of Herdr's own + menu, in the picked folder. Keys 1–9 start the agents in order.
// Folders you add by typing a path stay listed (right under the focused one) until
// you × them. Every row has a ×; a ×'d folder stays hidden (shared "telemetry.hidden"),
// even the focused or an open terminal's, until something is started in it or it's
// added again. While you type, the folders there are offered below the field (Tab, Enter
// on a half-typed name, or a click fills one in; ↑/↓ moves between them). History: shared "telemetry.folders" =
// { "<machine>" ("" for this one): [{ path, n, at, added? }] }; folders that no
// longer exist there are dropped each time the menu opens.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { spaces, panes, knownAgents, run, exec, openOverlay, closeOverlay, props, shared, setShared, home } from "herdr";
import { C, HUD, MONO, track, icon } from "./hud.js";

const FOLDERS = "telemetry.folders";
const AGENTS = "telemetry.agents"; // the last agents each machine reported, shown at once
const HOMES = "telemetry.homes"; // other machines' home folders, as last asked
const SHOWN = 7; // folders offered at most
const KEPT = 20; // history entries kept per machine
const HIDDEN = "telemetry.hidden"; // { "<machine>": [path] }: folders ×'d away, newest first
const HIDDEN_KEPT = 50;
// Tab, ↑ and ↓ inside the path field: bound as actions in its own key context, so they
// win over the window's Tab (which moves the keyboard to the next control).
const KEYS = [["tab", "telemetry_path_complete"], ["down", "telemetry_path_next"], ["up", "telemetry_path_prev"]];
let bound = false;

// A path with its machine's home as ~. Only that folder: /Users/Shared, or another
// user's, is not ~. Without a home (a suggestion: shown as typed), the path as it is.
const pretty = (p, h) => (h && (p === h || p.startsWith(`${h}/`)) ? `~${p.slice(h.length)}` : p);
// A whole path in reading order: the folders above dim, the last one bold (and never cut).
function pathLine(p, { home: h = null, on = false, size = 12, bold = C.text } = {}) {
  const q = pretty(p, h).replace(/(.)\/$/, "$1");
  const i = q.lastIndexOf("/");
  // "/" has no last part: it is the name itself.
  const head = i >= 0 && i < q.length - 1 ? q.slice(0, i + 1) : "";
  const name = q.slice(head.length);
  return h_flex().flex_1().min_w(0).items_center().font_family(MONO).text_size(size)
    .child(div().min_w(0).flex_shrink(1).truncate().text_color(C.dim).child(head))
    .child(div().flex_none().max_w(220).truncate().font_weight(700).text_color(on ? C.cyanHi : bold).child(name));
}

export default class Launch {
  init(p, cx) {
    this.space = spaces().find((s) => s.active) ?? null;
    this.where = this.space?.machine ?? "";
    this.agents = shared(AGENTS)?.[this.where] ?? [];
    // The space's machine's home, shown as ~: this one's, or another's as last asked (asked again below).
    this.home = this.space?.machine ? shared(HOMES)?.[this.where] ?? null : home();
    this.folder = this.folders()[0] ?? null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (!bound) { cx.bind_keys(KEYS.map(([keystroke, action]) => ({ keystroke, action, context: "TelemetryPath" }))); bound = true; }
    this.input = InputState.new({ placeholder: "Add a folder: ~/code/app · Enter" });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.on("change", (_e, cx) => { if (this.note !== "checking…") this.note = null; this.suggest(cx); });
    this.hints = []; // { name, value } folders under what's typed
    this.hint = 0; // the highlighted one
    this.asked = 0; // newest listing asked for; older answers are dropped
    this.listed = null; // { where, names }: the folder listed last, filtered again while typing inside it
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: this.space?.machine });
        setShared(AGENTS, { ...(shared(AGENTS) ?? {}), [this.where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
    if (this.space?.machine) cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.space.machine, timeout: 5000 }).catch(() => null);
      if (r?.code !== 0 || !r.stdout.startsWith("/")) return;
      this.home = r.stdout.replace(/\/+$/, "");
      if (shared(HOMES)?.[this.where] !== this.home) setShared(HOMES, { ...(shared(HOMES) ?? {}), [this.where]: this.home });
      cx.notify();
    });
    cx.spawn(async (cx) => {
      const paths = this.history().map((h) => h.path);
      if (!paths.length) return;
      // `ls -d` prints the ones that exist (and fails for the rest).
      const r = await exec("ls", ["-d", "--", ...paths], { on: this.space?.machine, timeout: 5000 }).catch(() => null);
      if (!r || (!r.stdout && r.code !== 0 && !r.stderr)) return;
      const there = new Set(r.stdout.split("\n").filter(Boolean));
      const gone = paths.filter((x) => !there.has(x));
      if (!gone.length) return;
      // Only the ones asked about: a folder added meanwhile stays.
      setShared(FOLDERS, { ...(shared(FOLDERS) ?? {}), [this.where]: this.history().filter((h) => !gone.includes(h.path)) });
      if (gone.includes(this.folder)) this.folder = this.folders()[0] ?? null;
      cx.notify();
    });
  }

  close() {
    this.closed = true; // a folder check still on its way mustn't touch the released field
    this.input?.release();
  }

  // The folders inside what's typed so far, read on the space's machine (~ and
  // relative paths from its home), that start with its last part.
  suggest(cx) {
    const text = this.input.value();
    const cut = text.lastIndexOf("/");
    const dir = text === "~" ? "~/" : cut >= 0 ? text.slice(0, cut + 1) : "";
    const part = text === "~" ? "" : text.slice(cut + 1);
    const n = ++this.asked; // an emptied field drops a listing on its way too
    if (!text) { this.hints = []; cx.notify(); return; }
    const where = dir === "" || dir === "~/" ? "." : dir.startsWith("~/") ? dir.slice(2) : dir;
    const show = (names, cx) => {
      const low = part.toLowerCase();
      this.hints = names
        .filter((f) => (part.startsWith(".") || !f.startsWith(".")) && f.toLowerCase().startsWith(low))
        .sort((a, b) => a.localeCompare(b)).slice(0, 6)
        .map((f) => ({ name: f, value: `${dir}${f}/` }));
      this.hint = 0;
      cx.notify();
    };
    // Typing on inside the same folder: nothing runs, what was read there is filtered again.
    if (this.listed?.where === where) return show(this.listed.names, cx);
    cx.spawn(async (cx) => {
      await cx.sleep(120); // typing on: only the last keystroke's listing runs
      if (n !== this.asked) return;
      const r = await exec("sh", ["-c", 'CDPATH= cd -- "$1" 2>/dev/null && for f in * .[!.]*; do [ -d "$f" ] && printf "%s\\n" "$f"; done | head -400', "sh", where],
        { on: this.space?.machine, cwd: this.space?.machine ? undefined : home(), timeout: 4000 }).catch(() => null);
      if (n !== this.asked) return;
      const names = (r?.stdout ?? "").split("\n").filter(Boolean);
      if (r?.code === 0) this.listed = { where, names };
      show(names, cx);
    });
  }

  // The highlighted suggestion, unless it's still the one for an older text (its
  // folder's listing is on its way).
  picked() {
    const h = this.hints[this.hint];
    return h?.value.toLowerCase().startsWith(this.input.value().toLowerCase()) ? h : null;
  }

  // Enter: while the last part is only the start of a suggested folder's name, fill
  // that folder in (as Tab does); once it names a folder (or ends in /, or is ~), add it.
  enter(cx) {
    const text = this.input.value();
    const part = text.slice(text.lastIndexOf("/") + 1);
    const h = this.picked();
    if (h && part && text !== "~" && !text.endsWith("/") && !this.hints.some((x) => x.name === part)) return this.complete(h, cx);
    this.add(text, cx);
  }

  step(by, cx) {
    if (!this.hints.length) return;
    this.hint = (this.hint + by + this.hints.length) % this.hints.length;
    cx.notify();
  }

  // Fills in a suggestion and lists what's inside it.
  complete(h, cx) {
    if (!h) return;
    this.input.set_value(h.value);
    this.input.focus();
    this.suggest(cx);
  }

  // A typed folder: resolved on the space's machine (~ and relative paths from its
  // home), kept if it's a folder there, and picked.
  add(text, cx) {
    const typed = String(text ?? "").trim();
    if (!typed) return;
    const rel = typed.replace(/^~(\/|$)/, "") || ".";
    this.note = "checking…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'CDPATH= cd -- "$1" 2>/dev/null && pwd', "sh", rel],
        { on: this.space?.machine, cwd: this.space?.machine ? undefined : home(), timeout: 5000 }).catch(() => null);
      if (this.closed) return;
      const path = r?.code === 0 ? r.stdout.trim() : "";
      if (!path) {
        this.note = `No folder ${typed} on ${this.space?.machine ?? "this machine"}`;
      } else {
        const all = shared(FOLDERS) ?? {};
        const was = this.history().find((x) => x.path === path);
        const h = [{ path, n: was?.n ?? 0, at: was?.at ?? Date.now(), added: true }, ...this.history().filter((x) => x.path !== path)];
        setShared(FOLDERS, { ...all, [this.where]: h });
        this.unhide(path);
        this.folder = path;
        this.note = null;
        this.input.set_value("");
        this.hints = [];
      }
      cx.notify();
    });
  }

  history() {
    const h = shared(FOLDERS)?.[this.where];
    return Array.isArray(h) ? h : [];
  }

  focusedCwd() {
    return panes().find((p) => p.focused && p.terminal)?.cwd ?? null;
  }

  // Folders of terminals open now on the space's machine (pane → tab → space).
  liveCwds() {
    const machineOf = new Map();
    for (const s of spaces()) for (const t of s.tabs) machineOf.set(t.id, s.machine ?? "");
    return panes().filter((p) => p.terminal && p.cwd && machineOf.get(p.tab) === this.where).map((p) => p.cwd);
  }

  // Folders ×'d away on the space's machine: kept hidden even while a terminal is open
  // there, until this menu starts something in one or it's added again.
  hidden() {
    const h = shared(HIDDEN)?.[this.where];
    return Array.isArray(h) ? h : [];
  }

  unhide(path) {
    if (!this.hidden().includes(path)) return;
    setShared(HIDDEN, { ...(shared(HIDDEN) ?? {}), [this.where]: this.hidden().filter((x) => x !== path) });
  }

  folders() {
    const added = this.history().filter((h) => h.added).map((h) => h.path);
    const used = this.history().filter((h) => !h.added).sort((a, b) => b.n - a.n || b.at - a.at).map((h) => h.path);
    const hidden = this.hidden();
    const out = [];
    for (const f of [this.focusedCwd(), ...added, ...used, ...this.liveCwds()]) if (f && !out.includes(f) && !hidden.includes(f)) out.push(f);
    // Added folders are always offered; the rest fill up to SHOWN.
    return out.slice(0, Math.max(SHOWN, 1 + added.length));
  }

  remember(path) {
    if (!path) return;
    this.unhide(path);
    const all = shared(FOLDERS) ?? {};
    const h = this.history().filter((x) => x.path !== path);
    const was = this.history().find((x) => x.path === path);
    h.unshift({ ...was, path, n: (was?.n ?? 0) + 1, at: Date.now() });
    // Added folders are kept whatever their age; used ones, the newest KEPT.
    const keep = [...h.filter((x) => x.added), ...h.filter((x) => !x.added).sort((a, b) => b.at - a.at).slice(0, KEPT)];
    setShared(FOLDERS, { ...all, [this.where]: keep });
  }

  // Out of the history, and hidden so an open terminal there doesn't bring it back.
  forget(path) {
    const all = shared(FOLDERS) ?? {};
    setShared(FOLDERS, { ...all, [this.where]: this.history().filter((x) => x.path !== path) });
    const hidden = [path, ...this.hidden().filter((x) => x !== path)].slice(0, HIDDEN_KEPT);
    setShared(HIDDEN, { ...(shared(HIDDEN) ?? {}), [this.where]: hidden });
    if (this.folder === path) this.folder = this.folders()[0] ?? null;
  }

  // Closes the menu, then starts it in the picked folder.
  go(action) {
    const folder = this.folder ?? undefined;
    closeOverlay(props().overlay);
    this.remember(folder);
    action(folder);
  }

  start(agent) {
    this.go((folder) => run("tab.new", { name: agent.name, space: this.space?.id, folder, argv: agent.run }));
  }

  folderRow(path, i) {
    const on = path === this.folder;
    return h_flex().id(`fd-${i}`).h(28).px(8).gap(8).items_center().flex_none().cursor_pointer()
      .border(1).border_color(on ? "#5ce1e666" : "#00000000").bg(on ? "#5ce1e614" : "#00000000")
      .hover((st) => st.bg("#5ce1e61f"))
      .tooltip(this.history().find((h) => h.path === path)?.added ? `${path} (added by you)` : path)
      .on_click((_e, cx) => { this.folder = path; cx.notify(); })
      .child(div().w(6).h(6).flex_none().bg(on ? C.cyan : C.faint))
      .child(pathLine(path, { home: this.home, on, size: 11.5 }))
      .child(
        div().id(`fd-x-${i}`).w(16).h(16).flex().flex_none().items_center().justify_center().text_size(11).text_color(C.dim)
          .hover((st) => st.text_color(C.amber).bg("#ffb5471f")).tooltip("Forget this folder")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.forget(path); cx.notify(); })
          .child("×"));
  }

  row(id, glyph, name, hint, action, enabled = true) {
    return h_flex().id(id).h(30).px(8).gap(10).items_center().flex_none()
      .text_color(enabled ? C.text : C.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg("#ffb5471f")).on_click(() => action()))
      .child(div().w(14).flex().flex_none().justify_center().child(glyph))
      .child(div().flex_1().min_w(0).text_size(12.8).truncate().child(name))
      .child(div().font_family(MONO).text_size(10.5).text_color(C.dim).child(hint));
  }

  heading(text) {
    return div().px(8).pt(8).pb(4).font_family(HUD).font_weight(700).text_size(11).text_color(C.amber).child(track(text));
  }

  render() {
    const folders = this.folders();
    if (this.folder && !folders.includes(this.folder)) folders.unshift(this.folder);
    const installed = this.agents.filter((a) => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter((a) => !a.installed).slice(0, 2)];
    const space = this.space;
    const h = 30 + Math.max(1, folders.length) * 30 + 40 + this.hints.length * 22 + (this.note ? 18 : 0) + 34 + 26 + Math.max(1, choices.length) * 30 + 11 + 3 * 30 + 14;
    return v_flex().id("launch").w_full().h(Math.min(640, h)).p(5).bg("#0b0c0f").border(1).border_color("#ffb54755")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.typing || e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (agent) this.start(agent);
      })
      .child(this.heading("Start in"))
      .child(v_flex().gap(2).flex_none().children(folders.map((f, i) => this.folderRow(f, i)))
        .when(!folders.length, (el) => el.child(div().px(8).py(6).text_size(11.5).text_color(C.dim).child("The focused terminal's folder"))))
      .child(div().mx(4).mt(6).flex_none().key_context("TelemetryPath")
        .on_action("telemetry_path_complete", (_e, cx) => this.complete(this.picked(), cx))
        .on_action("telemetry_path_next", (_e, cx) => this.step(1, cx))
        .on_action("telemetry_path_prev", (_e, cx) => this.step(-1, cx))
        .border(1).border_color(this.typing ? "#5ce1e666" : "#f4efe42e").bg("#00000066").text_size(12).child(Input.new(this.input)))
      .when(this.hints.length > 0, (el) => el.child(v_flex().mx(4).flex_none().border_l(1).border_r(1).border_b(1).border_color("#5ce1e633")
        .children(this.hints.map((h, i) => h_flex().id(`hint-${i}`).h(22).px(8).gap(6).items_center().cursor_pointer()
          .bg(i === this.hint ? "#5ce1e61a" : "#00000000").hover((st) => st.bg("#5ce1e61f"))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.complete(h, cx))
          .child(pathLine(h.value, { on: i === this.hint, size: 11 }))
          .when(i === this.hint, (r) => r.child(div().font_family(MONO).text_size(10).text_color(C.dim).child("Tab")))))))
      .when(Boolean(this.note), (el) => el.child(div().px(8).pt(3).text_size(10.5).text_color(this.note === "checking…" ? C.dim : C.redSoft).truncate().child(this.note)))
      .child(div().h(1).mx(4).my(5).flex_none().bg("#ffb54733"))
      .child(this.row("ln-terminal", icon("plus", 10, C.amber), "Terminal", "", () => this.go((folder) => run("tab.new", { space: space?.id, folder }))))
      .child(this.heading("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().id("ln-agents")
        .children(choices.map((a, i) => this.row(`ln-${a.key}`,
          a.tint ? svg(a.icon).size(14).text_color(C.ink) : image(a.icon).size(14), a.name,
          a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", () => this.start(a), a.installed)))
        .when(this.failed || !this.agents.length, (el) => el.child(div().px(8).py(6).text_size(11.5).text_color(C.dim)
          .child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).flex_none().bg("#ffb54733"))
      .child(this.row("ln-space", div().text_color(C.amber).child("+"), "New space here", "",
        () => this.go((folder) => run("space.new", { folder, machine: space?.machine ?? "" }))))
      .child(this.row("ln-worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", "",
        () => this.go((folder) => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder, action: "new" } })), Boolean(space)))
      .child(this.row("ln-worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree…", "",
        () => this.go((folder) => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder, action: "open" } })), Boolean(space)));
  }
}
