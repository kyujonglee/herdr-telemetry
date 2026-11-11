// Sessions: every agent at a glance — what it's working on, in one or two lines.
// Agents that need input come first, with what they're asking, what it's about
// (the command, the file) and their numbered choices. Then every other session:
// its task title, its status and how long ago it changed, and what it's doing or
// did, in up to five lines (Claude Code's `※ recap`, else its last message, else its title).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, spaces, hc, run } from "herdr";
import { C, MONO, STATUS, panel, label, mono, blink, ago, agentTitle, agentWhere } from "./hud.js";
import { parseScreen, sameChoice } from "./data.js";
import { sleepers } from "./cryo.js";

const RECHECK = 20000; // a working agent's screen is re-read this often
const ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };

const since = (at) => {
  const s = ago(Date.now() - at);
  return s === "now" ? "now" : `${s} ago`;
};

export default class Caution {
  init(props, cx) {
    this.props = props ?? {};
    this.reads = new Map(); // address → { seq, at, parsed }
    this.seen = new Map(); // address → when this panel first saw it
    this.sent = new Map(); // address → the key pressed (until its screen changes)
    this.pending = new Set(); // addresses with a key press on its way
    cx.timer.every(2500, (cx) => this.sync(cx));
    this.sync(cx);
  }

  sessions() {
    return [...agents()].sort((a, b) => (ORDER[a.status] ?? 4) - (ORDER[b.status] ?? 4) || b.seq - a.seq);
  }

  // Read a screen when its agent's state moved (seq); a working one also every 20 s,
  // since what it's doing changes without a state change.
  sync(cx) {
    const now = Date.now();
    const list = this.sessions();
    const live = new Set(list.map((a) => a.address));
    for (const k of [...this.seen.keys()]) if (!live.has(k)) { this.seen.delete(k); this.sent.delete(k); this.reads.delete(k); }
    for (const a of list) if (!this.seen.has(a.address)) this.seen.set(a.address, now);
    const stale = list.filter((a) => {
      const r = this.reads.get(a.address);
      return !r || r.seq !== a.seq || (a.status === "working" && now - r.at > RECHECK);
    });
    if (!stale.length || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      for (const a of stale) {
        const r = await hc(["read", a.address, "--lines", "80"]).catch(() => null);
        const prev = this.reads.get(a.address);
        if (prev?.seq !== a.seq) this.sent.delete(a.address);
        const parsed = r?.code === 0 ? parseScreen(r.stdout) : prev?.parsed ?? {};
        // A screen full of tool output says nothing new: keep what it said before.
        if (!parsed.last && !parsed.recap && prev?.parsed) { parsed.last = prev.parsed.last; parsed.recap = prev.parsed.recap; }
        this.reads.set(a.address, { seq: a.seq, at: Date.now(), parsed });
      }
      this.reading = false;
      cx.notify();
    });
  }

  // Press a choice only once, and only if the screen still asks exactly what was shown.
  choose(a, opt, cx) {
    if (this.pending.has(a.address) || this.sent.has(a.address)) return;
    this.pending.add(a.address);
    const shown = this.reads.get(a.address)?.parsed;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", a.address, "--lines", "40"]).catch(() => null);
        const now = r?.code === 0 ? parseScreen(r.stdout) : null;
        if (now && sameChoice(shown, now)) {
          const k = await hc(["keys", a.address, opt.key]).catch(() => null);
          if (k?.code === 0) this.sent.set(a.address, opt.key);
        } else {
          run("agent.focus", { terminal: a.address });
        }
      } finally {
        this.pending.delete(a.address);
        cx.notify();
      }
    });
  }

  // How long it has waited: its tab's last state change, else when this panel first saw it.
  age(a) {
    const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === a.tab);
    return since(tab?.changed_at ?? this.seen.get(a.address) ?? Date.now());
  }

  button(id, text, { primary = false, tip, on, color = C.ink } = {}) {
    return div().id(id).px(8).h(24).flex().items_center().cursor_pointer().max_w_full()
      .border(1).border_color(primary ? C.amber : "#f4efe455").bg(primary ? C.amber : "#00000000")
      .hover((st) => st.bg(primary ? C.amberHi : "#f4efe41a"))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click(on)
      .child(div().text_size(11.5).font_weight(700).text_color(primary ? C.bg : color).truncate().child(text));
  }

  hold(a) {
    const p = this.reads.get(a.address)?.parsed ?? {};
    const sent = this.sent.get(a.address);
    const busy = this.pending.has(a.address);
    // Buttons only for a live menu (a selection marker) whose subject we can show.
    const answerable = Boolean(p.options?.some((o) => o.selected) && p.context?.length);
    const ask = p.question ?? p.last ?? a.title;
    return v_flex().id(`hold-${a.address}`).gap(7).p(9).border(1).border_color("#ff5b3a99").bg("#ff5b3a12")
      .child(
        h_flex().gap(7).items_center()
          .child(blink(div().w(7).h(7).flex_none().bg(C.red), 900))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(13).font_weight(700).text_color(C.ink).truncate().child(agentTitle(a)))
            .child(div().text_size(10.5).text_color(C.muted).truncate().child(agentWhere(a))))
          .child(div().text_size(10.5).text_color(C.redSoft).whitespace_nowrap().child(this.age(a)))
      )
      .when(Boolean(p.context?.length), (el) =>
        el.child(v_flex().px(8).py(6).bg("#00000066").border_l(2).border_color("#ffb54788")
          .children(p.context.map((l, i) => div().font_family(MONO).text_size(11).line_height("16px").text_color(i === 0 ? C.muted : C.ink).child(l.slice(0, 160)))))
      )
      .child(div().font_family(MONO).text_size(11.5).line_height("17px").text_color("#efe7d7").child(String(ask ?? "").slice(0, 220)))
      .child(
        h_flex().gap(5).flex_wrap()
          .when(answerable && !sent && !busy, (el) =>
            el.children(p.options.map((o) =>
              this.button(`opt-${a.address}-${o.key}`, `${o.key} · ${o.text}`, {
                primary: o.selected,
                tip: `Press ${o.key} in that terminal: ${o.text}`,
                on: (_e, cx) => this.choose(a, o, cx),
              })
            ))
          )
          .when(busy, (el) => el.child(div().text_size(10.5).text_color(C.amber).child("sending…")))
          .when(Boolean(sent), (el) => el.child(div().text_size(10.5).text_color(C.amber).child(`sent ${sent} · waiting for the agent`)))
          .child(this.button(`open-${a.address}`, answerable ? "Open" : "Open to answer", { color: C.cyan, tip: "Go to this agent", on: () => run("agent.focus", { terminal: a.address }) }))
      );
  }

  // One session: status, task title, age, then what it's doing in up to five lines.
  row(a) {
    const p = this.reads.get(a.address)?.parsed ?? {};
    const st = STATUS[a.status] ?? STATUS.idle;
    const title = agentTitle(a);
    // Working: what it last said now; otherwise its recap of the whole turn.
    const line = (a.status === "working" ? p.last ?? p.recap ?? (p.action ? `▸ ${p.action}` : null) : p.recap ?? p.last) ?? (a.title && a.title !== title ? a.title : null);
    const done = a.status === "done";
    const tc = done ? C.green : a.status === "working" ? C.cyanHi : C.text;
    return h_flex().id(`ses-${a.address}`).gap(8).items_start().py(6).px(4).cursor_pointer()
      .hover((h) => h.bg("#ffb54714"))
      .tooltip(`${agentWhere(a)} — click to go there`)
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(div().w(2).self_stretch().flex_none().bg(done ? "#9be59b88" : a.status === "working" ? "#5ce1e688" : "#ffb54733"))
      .child(
        v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(12.5).font_weight(700).text_color(tc).flex_1().min_w(0).truncate().child(title))
            .child(div().text_size(10).text_color(st.c).whitespace_nowrap().child(`${(st.word ?? "").toLowerCase()} · ${this.age(a)}`)))
          // Up to five lines of what it's doing (the left column has the room).
          .when(Boolean(line), (el) => el.child(
            div().font_family(MONO).text_size(11).line_height("16px").max_h(80).overflow_hidden()
              .text_color(a.status === "idle" ? C.muted : C.text).child(String(line).slice(0, 480))))
      );
  }

  // A session put to sleep in Resources: its conversation is kept, nothing runs.
  sleeper(s) {
    return h_flex().id(`ses-cryo-${s.address}`).gap(8).items_center().py(5).px(4).opacity(0.75)
      .tooltip("Asleep: wake it in Resources")
      .child(div().w(2).h(16).flex_none().bg(C.cryo))
      .child(div().text_size(12.5).font_weight(700).text_color(C.cryoHi).flex_1().min_w(0).truncate().child(s.title || s.app || s.address))
      .child(div().text_size(10).text_color(C.cryo).whitespace_nowrap().child("asleep"));
  }

  body() {
    const list = this.sessions();
    const holds = list.filter((a) => a.status === "blocked");
    const rest = list.filter((a) => a.status !== "blocked");
    const sl = sleepers();
    return v_flex().id("sessions").size_full().px(10).py(8).gap(8).overflow_y_scrollbar()
      .children(holds.map((a) => this.hold(a)))
      .children(rest.map((a) => this.row(a)))
      .children(sl.map((s) => this.sleeper(s)))
      .when(!list.length && !sl.length, (el) => el.child(v_flex().py(14).items_center().gap(4).child(label("no sessions", C.dim)).child(div().text_size(11).text_color(C.dim).child("Start one with + in the tab strip"))));
  }

  render() {
    const list = this.sessions();
    const n = (st) => list.filter((a) => a.status === st).length;
    const parts = [[n("blocked"), "input"], [n("done"), "done"], [n("working"), "working"], [n("idle"), "idle"]].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
    return panel({
      block: this.props.block,
      open: this.props.open,
      title: "Sessions",
      right: n("blocked") ? div().text_size(11.5).font_weight(700).text_color(C.red).child(`${n("blocked")} needs input`) : null,
      summary: parts.join(" · ") || "none",
      accent: n("blocked") ? "#ff5b3a66" : undefined,
      body: () => this.body(),
    });
  }
}
