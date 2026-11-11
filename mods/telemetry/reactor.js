// Resources ("reactor"): CPU and memory per space (each terminal's whole process
// tree), one row per space with a memory rod and a CPU bar that glide to new
// values, and Cryo / Wake per space.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, agents, terminals, exec, hc, run } from "herdr";
import { C, HUD, MONO, panel, label, mono, move, blink, track, isHidden, isCollapsed } from "./hud.js";
import { sleepers, freeze, wake, prune } from "./cryo.js";

const POLL = 5000;

export default class Reactor {
  init(props, cx) {
    this.props = props ?? {};
    this.pids = new Map(); // terminal address → shell pid
    this.load = new Map(); // space id → { cpu, mem }
    this.tree = null;
    this.armed = null; // { space, at, until }
    this.busy = new Set();
    // ps counts each core as 100 %, so a space using 6 cores reads 600 %. Show the
    // share of the whole machine instead (cores from sysctl; 8 until it answers).
    this.cores = 8;
    cx.spawn(async (cx) => {
      const r = await exec("sysctl", ["-n", "hw.ncpu"], { timeout: 3000 }).catch(() => null);
      const n = Number(r?.stdout?.trim());
      if (n > 0) { this.cores = n; cx.notify(); }
    });
    // Folded or hidden: skip the ps poll; values refresh when it opens again.
    cx.timer.every(POLL, (cx) => { if (!isHidden("c-right") && !(this.props.block && isCollapsed(this.props.block))) this.poll(cx); });
    this.poll(cx);
  }

  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const ps = await exec("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], { timeout: 5000 });
        const kids = new Map();
        const me = new Map();
        for (const line of ps.stdout.split("\n")) {
          const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
          if (!pid) continue;
          me.set(pid, { rss: Number(rss) || 0, cpu: Number(cpu) || 0 });
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        const sum = (pid) => {
          let rss = 0, cpu = 0;
          const stack = [String(pid)];
          const seen = new Set();
          while (stack.length) {
            const p = stack.pop();
            if (seen.has(p)) continue;
            seen.add(p);
            const m = me.get(p);
            if (m) { rss += m.rss; cpu += m.cpu; }
            for (const k of kids.get(p) ?? []) stack.push(k);
          }
          return { rss, cpu };
        };
        this.tree = { sum, has: (pid) => me.has(String(pid)) };

        const tabSpace = new Map();
        for (const s of spaces()) for (const t of s.tabs) tabSpace.set(t.id, s.id);
        const bySpace = new Map();
        const local = terminals().filter((t) => t.state === "live" && !String(t.address).includes("/"));
        for (const t of local) {
          const pane = panes().find((p) => p.terminal === t.address);
          const space = (pane && tabSpace.get(pane.tab)) ?? t.labels?.["herdr.space"];
          if (!space) continue;
          let pid = t.pid ?? this.pids.get(t.address);
          if (!pid || !me.has(String(pid))) {
            const r = await hc(["get", t.address, "--json"]);
            try { pid = JSON.parse(r.stdout).pid; } catch { pid = null; }
            if (pid) this.pids.set(t.address, pid);
          }
          if (!pid) continue;
          const u = sum(pid);
          const acc = bySpace.get(space) ?? { cpu: 0, mem: 0 };
          acc.cpu += u.cpu;
          acc.mem += u.rss / 1048576; // KiB → GiB
          bySpace.set(space, acc);
        }
        this.load = bySpace;
        this.error = null;
        prune(new Set(spaces().map((s) => s.id)));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.polling = false;
      cx.notify();
    });
  }

  act(space, cx) {
    const asleep = sleepers().some((s) => s.space === space.id);
    if (asleep) {
      this.busy.add(space.id);
      cx.spawn(async (cx) => { await wake(space.id); this.busy.delete(space.id); cx.notify(); });
      return;
    }
    const now = Date.now();
    // Two separate presses: the first arms for 4 s; a second within 0.7 s (a double
    // click) is ignored, so one hasty double click never quits anything.
    if (this.armed?.space !== space.id || now > this.armed.until) {
      this.armed = { space: space.id, at: now, until: now + 4000 };
      cx.timer.after(4100, (cx) => cx.notify());
      cx.notify();
      return;
    }
    if (now - this.armed.at < 700) return;
    this.armed = null;
    this.busy.add(space.id);
    const rssOf = (pid) => (this.tree?.sum(pid).rss ?? 0) / 1048576;
    cx.spawn(async (cx) => { await freeze(space, rssOf); this.busy.delete(space.id); this.poll(cx); });
  }

  row(s, maxMem, all, sl) {
    const remote = Boolean(s.machine);
    const asleep = sl.filter((x) => x.space === s.id);
    const l = this.load.get(s.id) ?? { cpu: 0, mem: 0 };
    const mine = all.filter((a) => a.space === s.id);
    const working = mine.filter((a) => a.status === "working" || a.status === "blocked").length;
    const sleeping = asleep.length > 0 && !mine.length;
    const color = sleeping ? C.cryo : s.status === "blocked" ? C.red : s.status === "working" ? C.amber : C.muted;
    const armed = this.armed?.space === s.id && Date.now() < this.armed.until;
    const name = s.name === "/" || !s.name ? (s.machine ?? "home") : s.name;
    const btnText = remote ? "" : this.busy.has(s.id) ? "···" : asleep.length ? "WAKE" : armed ? (working ? `QUIT ${working} BUSY?` : "SURE?") : "CRYO";
    const memW = remote ? 0 : Math.max(2, Math.round((l.mem / maxMem) * 100));
    const share = l.cpu / this.cores; // % of the whole machine
    const cpuW = remote ? 0 : Math.min(100, Math.round(share));
    const rod = div().relative().h(8).w_full().bg("#ffb5470f").overflow_hidden()
      .child(div().absolute().left(0).top(0).h(8).w(`${memW}%`).bg(sleeping ? "#6f7f9966" : color).opacity(0.85).transition("width", { duration: 900, easing: "ease-out" }))
      .child(div().absolute().left(0).top(0).h(8).w("100%").child(stripesOverlay()));
    const cpu = div().relative().h(3).w_full().bg("#5ce1e612")
      .child(div().absolute().left(0).top(0).h(3).w(`${cpuW}%`).bg(C.cyan).transition("width", { duration: 900, easing: "ease-out" }));
    const btn = remote
      ? div().w(64).flex_none().text_size(10).text_color(C.dim).child(`on ${s.machine}`).truncate()
      : div().id(`cryo-${s.id}`).min_w(64).px(6).h(24).flex().flex_none().items_center().justify_center().border(1).cursor_pointer()
        .border_color(asleep.length ? "#ffb54799" : armed ? C.red : "#ffb54744")
        .bg(armed ? "#ff5b3a26" : "#00000000")
        .hover((st) => st.bg("#ffb5471f"))
        .on_click((_e, cx) => this.act(s, cx))
        .tooltip(asleep.length ? `Resume ${asleep.length} agent${asleep.length > 1 ? "s" : ""} in their conversations` : armed ? "Press again to quit this space's Claude Code / Codex agents" : "Quit this space's agents and keep their conversations (press twice)")
        .child(div().font_family(HUD).font_weight(700).text_size(11).text_color(armed ? C.red : asleep.length ? C.amberHi : C.text).whitespace_nowrap().child(track(btnText)));
    return h_flex().id(`rr-${s.id}`).gap(10).items_center().py(6).px(4).border_b(1).border_color("#ffb54714")
      .child(
        v_flex().id(`rrl-${s.id}`).flex_1().min_w(0).gap(4).cursor_pointer()
          .on_click(() => run("space.select", { id: s.id }))
          .tooltip(remote ? `Go to ${name}` : `${name}: ${Math.round(share)}% of this machine's CPU (${(l.cpu / 100).toFixed(1)} of ${this.cores} cores), ${l.mem.toFixed(1)} GB memory, everything its terminals started included. Click to go there.`)
          .child(h_flex().gap(6).items_center()
            .child(div().w(6).h(6).flex_none().bg(color))
            .child(div().font_family(HUD).font_weight(700).text_size(12.5).text_color(s.active ? C.ink : C.text).flex_1().min_w(0).truncate().child(track(name)))
            .child(mono(remote ? "—" : sleeping ? "asleep" : `${Math.round(share)}% cpu`, sleeping ? C.cryoHi : C.cyan, 10.5).flex_none())
            .child(mono(remote ? "" : `${l.mem.toFixed(1)} GB`, color, 10.5).flex_none()))
          // Asleep there's nothing to measure; without the bars the row is one line and WAKE sits level with it.
          .when(!remote && !sleeping, (el) => el.child(rod).child(cpu))
          .when(remote, (el) => el.child(div().text_size(10).text_color(C.dim).child("remote machine · not measured")))
      )
      .child(btn);
  }

  body() {
    const list = spaces();
    const sl = sleepers();
    const all = agents();
    const maxMem = Math.max(4, ...[...this.load.values()].map((l) => l.mem));
    const freed = sl.reduce((a, s) => a + (s.rss || 0), 0);
    return v_flex().size_full().px(10).py(8).gap(6)
      .child(h_flex().gap(10).items_center()
        .child(h_flex().gap(4).items_center().child(div().w(10).h(6).bg(C.amber)).child(div().text_size(10).text_color(C.muted).child("memory")))
        .child(h_flex().gap(4).items_center().child(div().w(10).h(3).bg(C.cyan)).child(div().text_size(10).text_color(C.muted).child("cpu"))))
      .child(list.length
        // Spaces on other machines can't be measured or put to sleep from here: not listed.
        // Sleeping spaces first: the footer below takes room, and WAKE mustn't scroll away.
        ? v_flex().id("reactor-rows").flex_1().min_h(0).overflow_y_scrollbar().children(list.filter((s) => !s.machine)
          .sort((a, b) => Number(sl.some((x) => x.space === b.id)) - Number(sl.some((x) => x.space === a.id)))
          .map((s) => this.row(s, maxMem, all, sl)))
        : div().flex_1().flex().items_center().justify_center().child(label("no spaces", C.dim)))
      .when(Boolean(this.error) || sl.length > 0, (el) => el.child(div().border_t(1).border_color("#ffb5471f").pt(6).text_size(10.5).text_color(this.error ? C.redSoft : C.muted)
        .child(this.error ? `Couldn't measure: ${this.error.slice(0, 60)}` : `${sl.length} asleep · about ${freed.toFixed(1)} GB freed. WAKE resumes the same conversations.`)));
  }

  render() {
    const total = [...this.load.values()].reduce((a, l) => ({ cpu: a.cpu + l.cpu, mem: a.mem + l.mem }), { cpu: 0, mem: 0 });
    const sum = `${Math.round(total.cpu / this.cores)}% cpu · ${total.mem.toFixed(1)} GB`;
    return panel({
      block: this.props.block, open: this.props.open, title: "Resources",
      // With one space its row already says it all; the total only adds up several.
      right: spaces().filter((s) => !s.machine).length > 1 ? mono(sum, C.amber, 10.5) : null,
      summary: `${sum}${sleepers().length ? ` · ${sleepers().length} asleep` : ""}`,
      body: () => this.body(),
    });
  }
}

// Reactor-rod segments over the memory bar.
function stripesOverlay() {
  return h_flex().size_full().gap(3).children(Array.from({ length: 80 }, () => div().w(3).h(8).flex_none().bg("#07080a55")));
}
