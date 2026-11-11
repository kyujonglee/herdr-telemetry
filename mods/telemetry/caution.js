// Sessions: every agent at a glance — what it's working on, in one or two lines.
// Agents that need input come first, with what they're asking, what it's about
// (for Claude Code the waiting tool call from its transcript: the whole command,
// the file, the question's own option texts) and their choices to answer from
// here: one choice, several ticked then Submit, or your own words. Then every other session:
// its task title, its status and how long ago it changed, and what it's doing or
// did, in up to five lines (Claude Code's `※ recap`, else its last message, else its title).

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, spaces, hc, run, exec, home } from "herdr";
import { C, MONO, STATUS, panel, label, mono, blink, ago, agentTitle, agentWhere } from "./hud.js";
import { parseScreen, sameMenu, moveKeys, pendingTool, describeTool, transcriptPath } from "./data.js";
import { sleepers } from "./cryo.js";

const RECHECK = 20000; // a working agent's screen is re-read this often
const ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };
const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const sigOf = (q) => (q?.choices?.length ? `${q.text}|${q.choices.map((c) => c.label).join("|")}` : "");

const since = (at) => {
  const s = ago(Date.now() - at);
  return s === "now" ? "now" : `${s} ago`;
};

export default class Caution {
  init(props, cx) {
    this.props = props ?? {};
    this.reads = new Map(); // address → { seq, at, parsed }
    this.seen = new Map(); // address → when this panel first saw it
    this.sent = new Map(); // address → { what, sig }: the answer sent, and the menu it answered
    this.pending = new Set(); // addresses with a key press on its way
    this.picks = new Map(); // address → { sig, set }: the boxes ticked here for a multiple choice
    this.inputs = new Map(); // address → InputState: your own answer
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
    for (const k of [...this.seen.keys()]) if (!live.has(k)) { this.seen.delete(k); this.sent.delete(k); this.reads.delete(k); this.picks.delete(k); }
    for (const [k, st] of [...this.inputs]) if (!live.has(k)) { st.release(); this.inputs.delete(k); }
    for (const a of list) {
      if (!this.seen.has(a.address)) this.seen.set(a.address, now);
      if (a.status === "blocked" && !this.inputs.has(a.address)) this.inputs.set(a.address, this.field(a.address));
    }
    const stale = list.filter((a) => {
      const r = this.reads.get(a.address);
      if (!r || r.seq !== a.seq || (a.status === "working" && now - r.at > RECHECK)) return true;
      // Answered from here: watch for the next question of a form (the status stays blocked).
      if (a.status === "blocked" && this.sent.has(a.address) && now - r.at > 2000) return true;
      // A tool call reaches the transcript a moment after its menu: look again, a few times.
      return a.status === "blocked" && isClaude(a) && !r.tool && r.tries < 3 && now - r.at > 3000;
    });
    if (!stale.length || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        for (const a of stale) {
          const r = await hc(["read", a.address, "--lines", "80"]).catch(() => null);
          const prev = this.reads.get(a.address);
          const same = prev?.seq === a.seq;
          if (!same) this.sent.delete(a.address);
          const parsed = r?.code === 0 ? parseScreen(r.stdout) : prev?.parsed ?? {};
          const sent = this.sent.get(a.address);
          if (sent && parsed.menu?.cursor != null && sigOf(parsed.menu) && sigOf(parsed.menu) !== sent.sig) this.sent.delete(a.address);
          // A screen full of tool output says nothing new: keep what it said before.
          if (!parsed.last && !parsed.recap && prev?.parsed) { parsed.last = prev.parsed.last; parsed.recap = prev.parsed.recap; }
          const tool = a.status === "blocked" && isClaude(a) ? (same && prev.tool) || (await this.toolOf(a).catch(() => null)) : null;
          this.reads.set(a.address, { seq: a.seq, at: Date.now(), parsed, tool, tries: same ? (prev.tries ?? 0) + 1 : 0 });
        }
      } finally {
        this.reading = false;
        cx.notify();
      }
    });
  }

  // The tool call a Claude Code agent waits on, from the end of its transcript:
  // its pid → ~/.claude/sessions/<pid>.json (session, folder) → the transcript's tail.
  async toolOf(a) {
    const on = spaces().find((s) => s.id === a.space)?.machine ?? null;
    const at = (rel) => (on ? rel : `${home()}/${rel}`); // elsewhere, commands start in its home
    const g = await hc(["get", a.address, "--json"]).catch(() => null);
    let pid = null;
    try { pid = JSON.parse(g?.stdout ?? "")?.foreground?.pid ?? null; } catch {}
    if (!Number.isInteger(pid)) return null;
    const s = await exec("cat", [at(`.claude/sessions/${pid}.json`)], { on }).catch(() => null);
    let meta = null;
    try { meta = JSON.parse(s?.stdout ?? ""); } catch { return null; }
    const rel = transcriptPath(meta?.cwd, meta?.sessionId);
    if (!rel) return null;
    const t = await exec("tail", ["-c", "400000", at(rel)], { on }).catch(() => null);
    return t?.code === 0 ? describeTool(pendingTool(t.stdout)) : null;
  }

  // Your own answer for an agent's free-text choice; Enter sends it.
  field(address) {
    const st = InputState.new({ placeholder: "Your own answer · Enter sends" });
    st.on("submit", (_e, cx) => {
      const a = agents().find((x) => x.address === address);
      const text = st.value().trim();
      const q = this.reads.get(address)?.parsed?.menu;
      if (!a || !text || q?.free == null) return;
      if (q.kind === "multi") this.submit(a, text, cx);
      else this.act(a, cx, async (q, cx) => {
        if (q.free == null) return null;
        // Its number puts the cursor in the field; the paste and its Enter answer.
        if (q.cursor !== q.free) { if (!(await this.keys(a, [String(q.free)]))) return null; await cx.sleep(250); }
        // The paste ends with Enter: only into the free field of this same menu.
        if (!(await this.inField(a, q))) return null;
        if (!(await this.paste(a, text))) return null;
        await this.confirm(a, cx);
        return text;
      });
      st.set_value("");
    });
    return st;
  }

  async reread(a) {
    const r = await hc(["read", a.address, "--lines", "60"]).catch(() => null);
    return r?.code === 0 ? parseScreen(r.stdout).menu : null;
  }
  async keys(a, list) {
    if (!list.length) return true;
    const r = await hc(["keys", a.address, ...list]).catch(() => null);
    return r?.code === 0;
  }
  async paste(a, text) {
    const r = await hc(["send", "--force", a.address, text]).catch(() => null);
    return r?.code === 0;
  }

  // Answer once, and only if the screen still shows exactly the menu that was shown here;
  // otherwise go to the agent. `work(menu, cx)` presses the keys and returns what was sent.
  act(a, cx, work) {
    if (this.pending.has(a.address) || this.sent.has(a.address)) return;
    const shown = this.reads.get(a.address)?.parsed?.menu;
    this.pending.add(a.address);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const now = await this.reread(a);
        if (!now || !sameMenu(shown, now)) { run("agent.focus", { terminal: a.address }); return; }
        const what = await work(now, cx);
        if (what) this.sent.set(a.address, { what, sig: sigOf(now) });
      } finally {
        this.pending.delete(a.address);
        cx.notify();
      }
    });
  }

  // One choice: arrows to it, then Enter.
  choose(a, c, cx) {
    this.act(a, cx, async (q, cx) => {
      if (!(await this.keys(a, [...moveKeys(q, c.n), "enter"]))) return null;
      await this.confirm(a, cx);
      return c.label;
    });
  }

  // True when the screen still shows menu \`q\` with the cursor on its free choice; else go to the agent.
  async inField(a, q, free = q.free) {
    const now = await this.reread(a);
    const ok = Boolean(now && now.text === q.text && now.cursor === free && now.choices.length === q.choices.length);
    if (!ok) run("agent.focus", { terminal: a.address });
    return ok;
  }

  // A question form ends on a review ("Ready to submit your answers?" → 1. Submit answers):
  // answering from here means submitting it too.
  async confirm(a, cx) {
    await cx.sleep(400);
    const q = await this.reread(a);
    if (q && /^Ready to submit your answers/i.test(q.text) && q.choices[0]?.label === "Submit answers" && q.cursor === 1) await this.keys(a, ["enter"]);
  }

  // Several choices: a number toggles its box, so press the ones that differ from what's
  // ticked here; then your own words in the free field, if any; then Submit.
  // Steps ported from herdr-relevo (Apache-2.0) via quaresc/cockpit (MIT); see data.js.
  submit(a, text, cx) {
    const want = this.picks.get(a.address)?.set ?? new Set();
    this.act(a, cx, async (q, cx) => {
      const settle = async () => { await cx.sleep(250); q = (await this.reread(a)) ?? q; };
      // From the free field a number would be typed: leave it first.
      if (q.free != null && q.cursor === q.free) { await this.keys(a, ["up"]); await settle(); }
      const toggles = q.choices.filter((c) => !c.free && c.checked !== null && c.checked !== want.has(c.n)).map((c) => String(c.n));
      if (!(await this.keys(a, toggles))) return null;
      if (text && q.free != null) {
        // Once typed, the field's label is the text: remember which choice it is.
        const free = q.free;
        await settle();
        await this.keys(a, moveKeys(q, free));
        if (!(await this.inField(a, q, free))) return null;
        await this.paste(a, text);
        await settle();
        const on = q.choices.find((c) => c.n === free)?.checked === true;
        await this.keys(a, on ? ["up"] : ["up", String(free)]);
      }
      await settle();
      if (q.submitAfter == null) return null;
      if (!(await this.keys(a, [...moveKeys(q, null), "enter"]))) return null;
      await this.confirm(a, cx);
      return [...q.choices.filter((c) => want.has(c.n)).map((c) => c.label), ...(text ? [text] : [])].join(", ") || "none";
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

  // A choice to press: its number, its label and what it means.
  choice(id, c, desc, { on, tick = null, cursor = false }) {
    return h_flex().id(id).gap(7).items_start().px(7).py(5).cursor_pointer()
      .border(1).border_color(cursor ? "#ffb54788" : "#f4efe42e")
      .hover((st) => st.bg("#ffb5471f"))
      .on_click(on)
      .child(tick === null
        ? div().w(16).flex_none().font_family(MONO).text_size(11).text_color(C.amber).child(`${c.n}`)
        : div().w(11).h(11).mt(2).flex_none().border(1).border_color(C.amber).bg(tick ? C.amber : "#00000000"))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(12).font_weight(700).text_color(C.ink).child(c.label.slice(0, 120)))
        .when(Boolean(desc), (el) => el.child(div().text_size(10.5).line_height("14px").text_color(C.muted).max_h(42).overflow_hidden().child(String(desc).slice(0, 240)))));
  }

  hold(a) {
    const r = this.reads.get(a.address);
    const p = r?.parsed ?? {};
    const q = p.menu;
    const tool = r?.tool;
    const sent = this.sent.get(a.address)?.what;
    const busy = this.pending.has(a.address);
    // Only a live menu (its cursor is on screen) is answered from here.
    const live = Boolean(q?.choices?.length >= 2 && q.cursor != null) && !sent && !busy;
    const multi = q?.kind === "multi";
    const canSubmit = !multi || q.submitAfter != null;
    // AskUserQuestion: the question on screen, with its option texts from the transcript.
    const asked = tool?.questions?.find((x) => q?.text && (norm(x.question) === norm(q.text) || norm(x.question).startsWith(norm(q.text))))
      ?? (tool?.questions?.length === 1 && tool.questions[0].options.every((o) => q?.choices?.some((c) => c.label === o.label)) ? tool.questions[0] : null);
    const desc = (c) => asked?.options.find((o) => o.label === c.label)?.description || c.detail;
    const nth = asked && tool.questions.length > 1 ? `${tool.questions.indexOf(asked) + 1} of ${tool.questions.length} · ${asked.header}` : null;
    const ask = asked?.question || (q?.choices?.length ? q.text : null) || p.last || q?.text || a.title;
    // Multiple choice: what's ticked here starts as what's ticked there.
    const sig = q ? `${q.text}|${q.choices.map((c) => c.label).join("|")}` : "";
    if (multi && this.picks.get(a.address)?.sig !== sig) this.picks.set(a.address, { sig, set: new Set(q.choices.filter((c) => c.checked && !c.free).map((c) => c.n)) });
    const picked = this.picks.get(a.address)?.set ?? new Set();
    const toggle = (n, cx) => { picked.has(n) ? picked.delete(n) : picked.add(n); cx.notify(); };
    const input = this.inputs.get(a.address);
    // The transcript's tool call only when the screen shows the same one (parallel calls, stale ones).
    const onScreen = norm([...(q?.context ?? []), q?.text ?? ""].join(" "));
    const agrees = (t) => {
      const key = norm(t.tool === "Bash" ? t.lines[0] : String(t.lines[0] ?? "").split("/").pop()).slice(0, 20);
      return Boolean(key) && onScreen.includes(key);
    };
    const about = tool?.lines?.length && agrees(tool) ? tool : q?.context?.length ? { tool: null, lines: q.context, note: null } : null;
    return v_flex().id(`hold-${a.address}`).gap(7).p(9).border(1).border_color("#ff5b3a99").bg("#ff5b3a12")
      .child(
        h_flex().gap(7).items_center()
          .child(blink(div().w(7).h(7).flex_none().bg(C.red), 900))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(13).font_weight(700).text_color(C.ink).truncate().child(agentTitle(a)))
            .child(div().text_size(10.5).text_color(C.muted).truncate().child(agentWhere(a))))
          .child(div().text_size(10.5).text_color(C.redSoft).whitespace_nowrap().child(this.age(a)))
      )
      // What it's about: the waiting tool call (whole command, file), else the box on screen.
      .when(Boolean(about), (el) =>
        el.child(v_flex().px(8).py(6).gap(1).bg("#00000066").border_l(2).border_color("#ffb54788")
          .when(Boolean(about.tool), (b) => b.child(div().text_size(10.5).font_weight(700).text_color(C.amber).child(about.tool)))
          .children(about.lines.map((l, i) => div().font_family(MONO).text_size(11).line_height("16px").text_color(i === 0 && !about.tool ? C.muted : C.ink).child(String(l).slice(0, 200))))
          .when(Boolean(about.note), (b) => b.child(div().text_size(10.5).text_color(C.muted).child(String(about.note).slice(0, 160)))))
      )
      .when(Boolean(nth), (el) => el.child(div().text_size(10.5).text_color(C.amber).child(nth)))
      .child(div().font_family(MONO).text_size(11.5).line_height("17px").text_color("#efe7d7").child(String(ask ?? "").slice(0, 300)))
      .when(live && canSubmit, (el) => el
        .child(v_flex().gap(4).children(q.choices.filter((c) => !c.free && (!multi || c.checked !== null)).map((c) =>
          multi
            ? this.choice(`tick-${a.address}-${c.n}`, c, desc(c), { tick: picked.has(c.n), on: (_e, cx) => toggle(c.n, cx) })
            : this.choice(`opt-${a.address}-${c.n}`, c, desc(c), { cursor: q.cursor === c.n, on: (_e, cx) => this.choose(a, c, cx) })
        )))
        .when(q.free != null && Boolean(input), (el) => el.child(div().border(1).border_color("#f4efe42e").bg("#00000066").child(Input.new(input))))
        .when(multi, (el) => el.child(this.button(`submit-${a.address}`, `Submit · ${picked.size} ticked`, {
          primary: true,
          tip: "Tick these in that terminal, add your own answer if typed, then Submit",
          on: (_e, cx) => this.submit(a, input?.value().trim() || null, cx),
        }))))
      .child(
        h_flex().gap(5).flex_wrap().items_center()
          .when(busy, (el) => el.child(div().text_size(10.5).text_color(C.amber).child("sending…")))
          .when(Boolean(sent), (el) => el.child(div().text_size(10.5).text_color(C.amber).flex_1().min_w(0).truncate().child(`sent: ${sent} · waiting for the agent`)))
          .child(this.button(`open-${a.address}`, live && canSubmit ? "Open" : "Open to answer", { color: C.cyan, tip: "Go to this agent", on: () => run("agent.focus", { terminal: a.address }) }))
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
