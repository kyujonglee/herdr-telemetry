// Pull requests ("docking sequence"): your pull requests in the repos your spaces
// are in, as five stages (open → checks → review → merge → deploy). The shown
// space's branch docks first, its stages one row each; the rest follow as one
// line each, in a scrolling list. Sits in the right column. Reads `gh`.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, exec, run } from "herdr";
import { C, HUD, MONO, panel, label, mono, icon, move, stripes, track, ago, isHidden, isCollapsed } from "./hud.js";
import { stages, runs, verdict } from "./data.js";

const SLOW = 90000;
const FAST = 30000;
const FIELDS = "number,title,headRefName,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,url,mergedAt,updatedAt,mergeCommit";

const TONE = { ok: C.amber, run: C.cyan, ready: C.green, fail: C.red, wait: C.dim, skip: C.faint };

export default class Dock {
  init(props, cx) {
    this.props = props ?? {};
    this.roots = new Map(); // cwd → repo root (or null)
    this.prs = []; // { repo, root, pr, st }
    this.deploys = new Map(); // merge sha → finished deploy summary (never changes again)
    this.at = 0;
    this.errors = [];
    cx.timer.every(FAST, (cx) => {
      // Folded or hidden: don't spend gh calls on what nobody sees.
      if (isHidden("c-right") || isHidden("c-dock") || (this.props.block && isCollapsed(this.props.block))) return;
      const live = this.prs.some((p) => p.st.some((s) => s.s === "run"));
      if (Date.now() - this.at >= (live ? FAST : SLOW) - 1000) this.refresh(cx);
    });
    this.refresh(cx);
  }

  async deploy(root, sha) {
    if (this.deploys.has(sha)) return this.deploys.get(sha);
    const [r, st] = await Promise.all([
      exec("gh", ["run", "list", "--commit", sha, "--limit", "20", "--json", "name,status,conclusion"], { cwd: root, timeout: 20000 }).catch(() => null),
      exec("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/status`, "--jq", ".statuses"], { cwd: root, timeout: 20000 }).catch(() => null),
    ]);
    const parse = (x) => { try { return x?.code === 0 ? JSON.parse(x.stdout || "[]") : []; } catch { return []; } };
    const d = runs(parse(r), parse(st));
    if (d.total && !d.run) this.deploys.set(sha, d);
    return d;
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const errors = [];
      try {
        const cwds = new Set(panes().filter((p) => p.terminal && !String(p.terminal).includes("/") && p.cwd).map((p) => p.cwd));
        for (const cwd of cwds) {
          if (this.roots.has(cwd)) continue;
          const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 }).catch(() => null);
          this.roots.set(cwd, r?.code === 0 ? r.stdout.trim() : null);
        }
        const roots = [...new Set([...cwds].map((c) => this.roots.get(c)).filter(Boolean))].slice(0, 8);
        const out = [];
        const day = Date.now() - 86400000;
        for (const root of roots) {
          const repo = root.split("/").pop();
          // Open ones, and ones merged in the last day (their deploys), asked separately.
          const ask = (state, limit) => exec("gh", ["pr", "list", "--author", "@me", "--state", state, "--limit", String(limit), "--json", FIELDS], { cwd: root, timeout: 20000 })
            .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          const [open, merged] = await Promise.all([ask("open", 20), ask("merged", 6)]);
          for (const r of [open, merged]) if (r.code !== 0) errors.push(`${repo}: ${(r.stderr || "gh failed").trim().split("\n")[0].slice(0, 70)}`);
          const prs = [...(open.code === 0 ? JSON.parse(open.stdout || "[]") : []), ...(merged.code === 0 ? JSON.parse(merged.stdout || "[]").filter((p) => Date.parse(p.mergedAt) > day) : [])];
          for (const pr of prs) {
            const deploy = pr.state === "MERGED" && pr.mergeCommit?.oid ? await this.deploy(root, pr.mergeCommit.oid) : null;
            out.push({ repo, root, pr, st: stages(pr, deploy) });
          }
        }
        out.sort((a, b) => Date.parse(b.pr.updatedAt) - Date.parse(a.pr.updatedAt));
        this.prs = out;
        this.at = Date.now();
      } catch (e) {
        errors.push(String(e?.message ?? e).slice(0, 80));
      }
      this.errors = [...new Set(errors)];
      this.loading = false;
      cx.notify();
    });
  }

  // The shown space's branch first, then the rest by last update.
  ordered() {
    const space = spaces().find((s) => s.active);
    const branches = new Set(panes().filter((p) => space?.tabs.some((t) => t.id === p.tab)).map((p) => p.branch).filter(Boolean));
    if (space?.branch) branches.add(space.branch);
    const mine = this.prs.filter((p) => branches.has(p.pr.headRefName));
    return [...mine, ...this.prs.filter((p) => !mine.includes(p))];
  }

  // One stage as a row: a short tube, its name, and its state on the right.
  stage(p, s) {
    const c = TONE[s.s] ?? C.dim;
    const quiet = s.s === "wait" || s.s === "skip";
    const fill = s.s === "ok" || s.s === "ready";
    const tube = div().w(34).h(8).flex_none().relative().overflow_hidden().border(1).border_color(quiet ? "#ffb54738" : c)
      .bg(fill ? (s.s === "ready" ? "#9be59b55" : c) : s.s === "fail" ? "#ff5b3a40" : "#00000000")
      .when(s.s === "run", (el) =>
        el.child(move(div().absolute().top(0).left(-44).w(120).h(8).child(stripes("#5ce1e68c", 6, 14)), (e) => e.loop("left", { from: -44, to: 0, period: 1200, easing: "linear" }))));
    const url = s.name === "CHECKS" ? `${p.pr.url}/checks` : p.pr.url;
    return h_flex().id(`seg-${p.pr.number}-${s.name}`).h(20).gap(8).items_center().cursor_pointer().hover((h) => h.bg("#ffb5470f"))
      .tooltip(`${s.name.toLowerCase()}: ${s.detail} — click to open on GitHub`)
      .on_click(this.open(url))
      .child(tube)
      .child(div().w(62).flex_none().font_family(HUD).font_weight(700).text_size(11.5).text_color(quiet ? C.dim : c).child(track(s.name)))
      .child(div().flex_1().min_w(0).font_family(MONO).text_size(10.5).text_color(s.s === "fail" ? C.redSoft : C.muted).truncate().child(s.detail));
  }

  open(url) {
    return () => exec("open", [url]).catch(() => null);
  }

  body() {
    const list = this.ordered();
    const lead = list[0];
    const err = this.errors.length ? div().font_family(MONO).text_size(10).text_color(C.redSoft).max_h(28).overflow_hidden().child(this.errors.join(" · ")) : null;
    if (!lead)
      return v_flex().size_full().px(12).gap(8).items_center().justify_center()
        .child(icon("ring", 20, C.dim))
        .child(label(this.loading ? "scanning for pull requests" : this.errors.length ? "couldn't read pull requests" : "no pull request in flight", this.loading ? C.cyan : this.errors.length ? C.redSoft : C.muted, 11.5))
        .child(err ?? div().text_size(10.5).text_color(C.dim).child("Your open PRs, and ones merged in the last day, in the repos your spaces are in."));
    const rest = list.slice(1);
    return v_flex().id("dock-body").size_full().px(10).py(8).gap(6)
      .child(
        v_flex().id(`pr-${lead.repo}-${lead.pr.number}`).gap(2).cursor_pointer().on_click(this.open(lead.pr.url)).tooltip(`Open ${lead.pr.url}\nbranch ${lead.pr.headRefName}`)
          .child(h_flex().gap(6).items_center()
            .child(div().relative().w(14).h(14).flex_none()
              .child(icon("ring", 14, C.cyan))
              .child(move(div().absolute().left(5).top(5).w(4).h(4).rounded_full().bg(C.cyan), (e) => e.loop("opacity", { from: 0.2, to: 1, period: 1600 }))))
            .child(mono(`#${lead.pr.number} · ${lead.repo}`, C.amberHi, 11)))
          .child(div().text_size(12).font_weight(600).text_color(C.ink).line_height("16px").max_h(32).overflow_hidden().child(lead.pr.title))
      )
      .child(v_flex().children(lead.st.map((s) => this.stage(lead, s))))
      .when(Boolean(err), (el) => el.child(err))
      .when(rest.length > 0, (el) =>
        el.child(
          v_flex().id("dock-rest").flex_1().min_h(0).pt(6).border_t(1).border_color("#ffb5471f").overflow_y_scrollbar()
            .children(rest.map((p) => {
              const v = verdict(p.st);
              const c = { ok: C.green, fail: C.redSoft, run: C.cyan, wait: C.muted }[v.tone];
              return h_flex().id(`prr-${p.repo}-${p.pr.number}`).h(20).gap(6).items_center().cursor_pointer().hover((h) => h.bg("#ffb5470f"))
                .on_click(this.open(p.pr.url)).tooltip(`#${p.pr.number} ${p.pr.title} — ${p.st.map((x) => `${x.name.toLowerCase()} ${x.detail}`).join(", ")}`)
                .child(h_flex().gap(2).flex_none().children(p.st.map((s) => div().w(5).h(5).bg(TONE[s.s] ?? C.dim))))
                .child(mono(`#${p.pr.number} ${p.repo}`, C.text, 10.5).flex_none())
                .child(mono(`${v.word}${v.why ? ` · ${v.why}` : ""}`, c, 10.5).truncate());
            }))
        )
      );
  }

  render() {
    const lead = this.ordered()[0];
    const v = lead ? verdict(lead.st) : null;
    return panel({
      block: this.props.block,
      open: this.props.open,
      title: "Pull requests",
      right: div().id("dock-refresh").px(6).h(22).flex().items_center().cursor_pointer().hover((st) => st.bg("#ffb5471f"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx); }).tooltip("Read again now")
        .child(mono(this.loading ? "reading…" : `${this.prs.length} PR · ↻ ${this.at ? (ago(Date.now() - this.at) === "now" ? "now" : `${ago(Date.now() - this.at)} ago`) : "—"}`, C.muted, 10.5)),
      summary: lead ? `#${lead.pr.number} ${lead.repo} · ${v.word}${v.tone === "fail" && v.why ? ` (${v.why})` : ""}` : "none",
      body: () => this.body(),
    });
  }
}
