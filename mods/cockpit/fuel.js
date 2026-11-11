// Plan limits ("propellant"): Claude Code and Codex usage as horizontal fuel
// gauges, one row per limit window, one group per provider, for the machine of
// the space you're in: this Mac and every connected machine are read (each can be
// signed in to its own account, with its own limits) and the shown one follows
// the active space. The fill is what's used; the white tick is how much
// of the window has already passed (fill above the tick: burning too fast);
// beside each gauge, the percent used and when it resets. Numbers come from the
// CLIs themselves (helpers/), every 5 minutes.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, machines, spaces, readTextFile, appHome, shared, setShared } from "herdr";
import { C, MONO, panel, label, mono, move, blink, left, ago, track } from "./hud.js";
import { claudeTapes, codexTapes, claudeAccount, codexAccount, fuelColor } from "./data.js";

const EVERY = 5 * 60000;
const PROVIDERS = [
  { id: "claude", name: "Claude Code", script: "claude-usage.sh", parse: claudeTapes,
    account: async (run) => { const r = await run("claude auth status --json", ["claude", ["auth", "status", "--json"]]); return r.code === 0 ? claudeAccount(r.stdout) : null; } },
  { id: "codex", name: "Codex", script: "codex-limits.sh", parse: codexTapes, accountOf: codexAccount },
];
const HERE = "this Mac";

export default class Fuel {
  init(props, cx) {
    this.props = props ?? {};
    // One read per provider per machine: "claude|" is this Mac, "claude|macmini" another.
    this.reads = new Map(); // key → { provider, machine, tapes, account, readAt, error }
    this.scripts = {};
    this.at = 0;
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => cx.notify()); // countdowns
    this.refresh(cx);
  }

  // This Mac, plus every connected machine: each can be signed in to its own account.
  targets() {
    return [null, ...machines().filter((m) => m.name && m.layout === "ready" && !m.temporary).map((m) => m.name)];
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/mods/cockpit/helpers`;
      let ok = false;
      const live = new Set();
      await Promise.all(this.targets().flatMap((m) => PROVIDERS.map(async (p) => {
        const key = `${p.id}|${m ?? ""}`;
        live.add(key);
        const prev = this.reads.get(key);
        // Locally: run the helper. Elsewhere: send the helper's text through `hc exec --on`.
        const run = async (remoteCmd, [cmd, args]) => (m ? hc(["exec", "--on", m, remoteCmd]) : exec(cmd, args, { timeout: 20000 }));
        try {
          if (m && this.scripts[p.script] == null) this.scripts[p.script] = (await readTextFile(`${dir}/${p.script}`)) ?? "";
          const r = await run(this.scripts[p.script], ["sh", [`${dir}/${p.script}`]]);
          if (r.code === 127) throw new Error("CLI not found");
          if (r.code !== 0) throw new Error("no answer");
          const line = r.stdout.trim().split("\n").pop();
          const readAt = Date.now();
          const tapes = (p.parse(line) ?? []).map((t) => ({ ...t, readAt }));
          const account = p.accountOf ? p.accountOf(line) : await p.account(run).catch(() => null);
          this.reads.set(key, { provider: p.id, machine: m, tapes, account, readAt });
          ok = true;
        } catch (e) {
          // Keep the last good numbers; only note the failure.
          this.reads.set(key, { ...(prev ?? { provider: p.id, machine: m, tapes: [], account: null }), error: String(e?.message ?? e).slice(0, 30) });
        }
      })));
      for (const k of [...this.reads.keys()]) if (!live.has(k)) this.reads.delete(k); // machine gone
      // Stamp only fresh numbers: a failed read keeps the old time.
      if (ok) this.at = Date.now();
      this.loading = false;
      this.share();
      cx.notify();
    });
  }

  // The machine whose limits show: the active space's (null = this Mac).
  machine() {
    const m = spaces().find((x) => x.active)?.machine ?? null;
    return this.targets().includes(m) ? m : null;
  }

  /** One group per provider, for one machine: its account, plan and limit windows. */
  groups(m = this.machine()) {
    const out = [];
    for (const p of PROVIDERS) {
      const r = this.reads.get(`${p.id}|${m ?? ""}`);
      if (!r || (!r.tapes.length && !r.error)) continue;
      out.push({ id: `${p.id}-${m ?? "here"}`, provider: p, account: r.account, tapes: r.tapes.slice(0, 3), error: r.tapes.length ? null : r.error });
    }
    return out;
  }

  // The title bar's "Used": the fullest window on the shown machine.
  share() {
    const m = this.machine();
    const worst = this.groups(m).flatMap((g) => g.tapes.map((t) => ({ ...t, name: `${g.provider.name} ${t.win} on ${m ?? HERE}` })))
      .reduce((w, t) => (t.pct > (w?.pct ?? -1) ? t : w), null);
    const prev = shared("cockpit.fuel");
    if (worst && (prev?.pct !== worst.pct || prev?.name !== worst.name)) setShared("cockpit.fuel", { pct: worst.pct, name: worst.name });
  }

  // One limit window as a row: name, gauge (fill = used, tick = time passed), %, reset.
  gauge(t, gid) {
    const c = t.quiet ? C.dim : fuelColor(t.pct, C);
    const fast = !t.quiet && t.pace != null && t.pct > t.pace + 8;
    const leftNow = t.reset ? t.reset - (Date.now() - (t.readAt ?? this.at)) : 0;
    const bar = div().relative().flex_1().min_w(30).h(8).overflow_hidden().border(1).border_color("#ffb54744").bg("#ffb54708")
      .child(div().absolute().left(0).top(0).h_full().w(`${Math.min(100, t.pct)}%`).bg(c).opacity(0.8).transition("width", { duration: 1400, easing: "ease-out" }))
      .child(h_flex().absolute().left(0).top(0).size_full().gap(3).children(Array.from({ length: 48 }, () => div().w(3).h_full().flex_none().bg("#07080a66"))))
      .when(t.pace != null, (el) => el.child(div().absolute().top(0).left(`${Math.round(t.pace)}%`).w(1).h_full().bg(fast ? C.red : C.ink)));
    const num = div().w(36).flex_none().font_family(MONO).font_weight(500).text_size(12).text_color(c).child(`${t.pct}%`);
    return h_flex().id(`g-${gid}-${t.name}`).h(18).gap(8).items_center()
      .tooltip(t.quiet
        ? `${t.win} limit: nothing used in this window yet`
        : `${t.win} limit: ${t.pct}% used, ${Math.round(t.pace ?? 0)}% of the window passed${fast ? " (burning faster than time)" : ""}${leftNow > 0 ? `. Resets in ${left(leftNow)}` : ""}`)
      .child(div().w(84).flex_none().text_size(11.5).font_weight(600).text_color(C.text).truncate().child(t.win))
      .child(bar)
      .child(t.pct >= 90 && !t.quiet ? blink(num, 900) : num)
      .child(div().w(48).flex_none().font_family(MONO).text_size(10).text_color(fast ? C.redSoft : C.dim).whitespace_nowrap()
        .child(t.quiet ? "unused" : fast ? "fast" : leftNow > 0 ? left(leftNow) : "—"));
  }

  // Provider, plan and the signed-in account, on one line.
  head(g) {
    const a = g.account;
    return h_flex().id(`acct-${g.id}`).gap(6).items_center().min_w(0)
      .tooltip(`${g.provider.name}${a?.email ? ` signed in as ${a.email}${a.plan ? ` (${a.plan} plan)` : ""}` : ": account unknown"}`)
      .child(div().text_size(11.5).font_weight(700).text_color(C.ink).whitespace_nowrap().child(g.provider.name))
      .when(Boolean(a?.plan), (el) => el.child(div().px(4).border(1).border_color("#ffb54755").text_size(9.5).font_weight(700).text_color(C.amber).child(track(a.plan))))
      .child(div().flex_1().min_w(0).font_family(MONO).text_size(10).text_color(C.muted).truncate().child(a?.email ?? "account unknown"));
  }

  body() {
    const groups = this.groups();
    return v_flex().id("fuel-body").size_full().px(12).pt(8).pb(8).gap(10)
      .child(groups.length
        ? v_flex().id("fuel-groups").flex_1().min_h(0).gap(10).overflow_y_scrollbar().children(groups.map((g) =>
          v_flex().gap(4)
            .child(this.head(g))
            .children(g.tapes.length ? g.tapes.map((t) => this.gauge(t, g.id)) : [mono(g.error ?? "no answer", C.redSoft, 10)])))
        : v_flex().flex_1().items_center().justify_center().gap(6)
          .child(this.loading ? move(label("reading usage", C.cyan), (e) => e.loop("opacity", { from: 0.3, to: 1, period: 900 })) : label("no usage data", C.dim)));
  }

  render() {
    // Folded: the fullest window of each provider, e.g. "Claude 19% · Codex 10%".
    const gs = this.groups();
    const top = (id) => gs.filter((g) => g.provider.id === id).flatMap((g) => g.tapes).reduce((m, t) => Math.max(m, t.pct), -1);
    const summary = [["claude", "Claude"], ["codex", "Codex"]].filter(([id]) => top(id) >= 0).map(([id, n]) => `${n} ${top(id)}%`).join(" ") || (this.loading ? "reading…" : "no data");
    // Refresh, age and any failed reads live in the title strip (the gauges' tooltips
    // explain fill and tick), so the body is only gauges.
    const stale = this.at > 0 && Date.now() - this.at > 3 * EVERY;
    const failed = [...this.reads.values()].filter((r) => r.error).map((r) => `${r.machine ?? HERE} · ${r.provider}: ${r.error}`);
    const age = this.at ? (ago(Date.now() - this.at) === "now" ? "now" : `${ago(Date.now() - this.at)} ago`) : "—";
    const m = this.machine();
    if (m !== this.lastMachine) { this.lastMachine = m; this.share(); }
    const right = div().id("fuel-refresh").px(6).h(22).flex().items_center().cursor_pointer().hover((st) => st.bg("#ffb5471f"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx); })
      .tooltip(`${stale ? "Last reads failed; these numbers are old. " : ""}Read again now${failed.length ? `\nCouldn't read: ${failed.join(", ")}` : ""}`)
      .child(mono(this.loading ? "reading…" : `${stale || failed.length ? "! " : ""}↻ ${age}`, stale || failed.length ? C.redSoft : C.muted, 10.5));
    // Which machine's limits these are, beside the title (only when there are several).
    const where = this.targets().length > 1
      ? h_flex().gap(6).items_center()
        .child(div().id("fuel-machine").px(5).border(1).border_color("#5ce1e655").text_size(10.5).font_weight(700).text_color(C.cyan)
          .tooltip("Limits of the active space's machine; switch spaces to see another machine's").child(m ?? HERE))
        .child(right)
      : right;
    return panel({ block: this.props.block, open: this.props.open, title: "Plan limits", right: where, summary: `${m ? `${m}: ` : ""}${summary}`, body: () => this.body() });
  }
}
