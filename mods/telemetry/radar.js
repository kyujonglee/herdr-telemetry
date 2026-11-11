// Proximity radar: every agent is a blip. The closer to the center, the more it
// needs you (input, then done, working, idle; cryo at the rim). Click to focus.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, run } from "herdr";
import { C, ASSETS, MONO, panel, label, mono, move, blink, STATUS, RANK, hash, agentTitle, agentWhere } from "./hud.js";
import { sleepers } from "./cryo.js";

// Ring radii for a 150 px scope (center = needs you most).
const R = { blocked: 23, done: 40, working: 55, idle: 67, cryo: 69 };
const SIZE = 150;

export default class Radar {
  init(props) {
    this.props = props ?? {};
  }

  body() {
    const list = [...agents()].sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq);
    const sl = sleepers();
    const all = [
      ...list.map((a) => ({ id: a.address, s: a.status, name: agentTitle(a), a })),
      ...sl.map((s) => ({ id: `cryo-${s.address}`, s: "cryo", name: s.title || s.app, cryo: s })),
    ];
    // Spread each ring's blips evenly (a hash alone stacks them), each ring turned its own way.
    const rings = new Map();
    for (const b of all) rings.set(b.s, [...(rings.get(b.s) ?? []), b]);
    const blips = [];
    for (const [s, ring] of rings) {
      const turn = hash(s) % 360;
      ring.forEach((b, i) => {
        const angle = ((turn + (i * 360) / ring.length) * Math.PI) / 180;
        const r = R[s] ?? 98;
        blips.push({ ...b, x: SIZE / 2 + Math.sin(angle) * r, y: SIZE / 2 - Math.cos(angle) * r });
      });
    }

    // Marks only: the Sessions list below names every agent, so the scope doesn't.
    // Hover names it, click goes there.
    const blip = (b) => {
      const c = STATUS[b.s]?.c ?? C.muted;
      let mark = div().w(8).h(8).bg(c).when(b.s !== "blocked", (el) => el.rounded_full());
      if (b.s === "cryo") mark = div().w(8).h(8).border(1).border_color(c);
      if (b.s === "blocked") mark = blink(mark, 900);
      return h_flex().id(`blip-${b.id}`).absolute().left(b.x - 8).top(b.y - 8).w(16).h(16).items_center().justify_center()
        .child(mark)
        .tooltip(b.a ? `${b.name}\n${agentWhere(b.a)} — ${STATUS[b.s]?.word ?? b.s}. Click to go there.` : `${b.name} · asleep (Wake it in Resources)`)
        .when(Boolean(b.a), (el) => el.cursor_pointer().hover((st) => st.bg("#5ce1e633")).on_click(() => run("agent.focus", { terminal: b.a.address })));
    };
    const halos = blips.filter((b) => b.s === "blocked").map((b) =>
      move(div().absolute().left(b.x - 10).top(b.y - 10).w(20).h(20).border(1).border_color(C.red), (e) => e.loop("opacity", { from: 0.1, to: 0.8, period: 1800 })));

    const count = (s) => list.filter((a) => a.status === s).length;
    const busy = count("working") + count("blocked") > 0;
    // The scope on the left, the counts beside it: the panel stays short.
    return h_flex().size_full().items_center().justify_center().gap(22).py(6)
      .child(
        div().relative().w(SIZE).h(SIZE).flex_none()
          .child(svg(`${ASSETS}/icons/radar-grid.svg`).absolute().left(0).top(0).size(SIZE).text_color(C.cyan))
          // The sweep turns only while something is happening.
          .when(busy, (el) => el.child(move(svg(`${ASSETS}/icons/sweep.svg`).absolute().left(0).top(0).size(SIZE).text_color(C.cyan), (e) => e.spin(4200))))
          .children(halos)
          .children(blips.map(blip))
          .when(blips.length === 0, (el) => el.child(h_flex().absolute().left(0).top(0).size_full().items_center().justify_center().child(label("no agents", C.dim))))
      )
      .child(
        v_flex().gap(9).children(
          ["blocked", "done", "working", "idle"].map((s) =>
            h_flex().gap(6).items_center().child(div().w(7).h(7).bg(STATUS[s].c))
              .child(div().w(42).font_family(MONO).text_size(10.5).text_color(count(s) ? STATUS[s].c : C.dim).child(STATUS[s].word))
              .child(mono(String(count(s)), count(s) ? C.ink : C.dim, 12)))
        )
      );
  }

  render() {
    const list = [...agents()].sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq);
    const n = (s) => list.filter((a) => a.status === s).length;
    return panel({
      block: this.props.block, open: this.props.open, title: "Agents",
      summary: `${n("working")} working · ${n("blocked")} input · ${n("done")} done`,
      body: () => this.body(),
    });
  }
}
