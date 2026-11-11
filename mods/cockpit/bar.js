// The title bar: brand, a drifting heading tape, crew / caution / fuel readouts,
// the clock, and the switches that show or hide the side panels and motion.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, run, shared, setShared, setAgentOrder, window as appWindow } from "herdr";
import { C, HUD, MONO, RANK, label, mono, icon, move, blink, isHidden, track, motionSetting } from "./hud.js";
import { fuelColor } from "./data.js";

const pad = (n) => String(n).padStart(2, "0");
const TICKS = Array.from({ length: 36 }, (_, i) => ({ major: i % 3 === 0, n: i % 3 === 0 ? String((i * 10) % 360).padStart(3, "0") : "" }));

export default class Bar {
  init(_props, cx) {
    // Columns this bar folded for a narrow window; kept in shared state so a reload
    // still brings them back when the window widens.
    this.auto = new Set(shared("cockpit.auto") ?? []);
    // The clock shows minutes: look every 2 s, redraw only when the minute turns.
    this.minute = Math.floor(Date.now() / 60000);
    cx.timer.every(2000, (cx) => {
      const m = Math.floor(Date.now() / 60000);
      if (m !== this.minute) { this.minute = m; cx.notify(); }
    });
  }

  toggle(id, on) {
    const shown = !isHidden(id);
    return div()
      .id(`tg-${id}`)
      .w(30)
      .h(26)
      .flex()
      .items_center()
      .justify_center()
      .border(1)
      .border_color(shown ? "#ffb54766" : "#ffb54722")
      .bg(shown ? "#ffb5471a" : "#00000000")
      .cursor_pointer()
      .hover((s) => s.bg("#ffb5472e"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { if (this.auto.delete(id)) setShared("cockpit.auto", [...this.auto]); run("layout.toggle", { id }); })
      .tooltip(on)
      .child(icon(id === "c-left" ? "panel-left" : id === "c-right" ? "panel-right" : "panel-bottom", 14, shown ? C.amber : C.dim));
  }

  // Narrow windows give the terminal room: below 1400 px the right column folds
  // away, below 1150 the left one too; they come back when the window widens again
  // (only the ones folded here, never ones you hid yourself).
  // Only on crossing the line (or the first layout): a column you reopen in a
  // narrow window stays open.
  fit(width, before) {
    for (const [id, min] of [["c-right", 1400], ["c-left", 1150]]) {
      if (width < min && (before == null || before >= min) && !isHidden(id)) { this.auto.add(id); run("layout.hide", { id }); }
      else if (width >= min + 40 && this.auto.has(id)) { this.auto.delete(id); run("layout.show", { id }); }
      else continue;
      setShared("cockpit.auto", [...this.auto]);
    }
  }

  render() {
    const list = agents();
    // agent.next / agent.prev follow the cockpit's order (input, done, working, idle);
    // set here because the bar never hides.
    setAgentOrder([...list].sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq).map((a) => a.address));
    const cryo = shared("cockpit.cryo") ?? [];
    const blocked = list.filter((a) => a.status === "blocked");
    const awake = list.filter((a) => a.status === "working").length;
    const fuel = shared("cockpit.fuel");
    const now = new Date();
    const mac = appWindow()?.platform === "macos";

    const tape = div()
      .flex_1()
      .min_w(80)
      .h(30)
      .relative()
      .overflow_hidden()
      .mx(28)
      .border_l(1)
      .border_r(1)
      .border_color("#ffb54740")
      .child(
        move(
          h_flex().absolute().top(2).left(-120).w(TICKS.length * 30).h(28).children(
            TICKS.map((k, i) =>
              v_flex().w(30).flex_none().items_center().gap(2)
                .child(div().w(1).h(k.major ? 10 : 5).bg(k.major ? "#ffb54799" : "#ffb54755"))
                .when(Boolean(k.n), (el) => el.child(div().font_family(MONO).text_size(9).text_color(C.muted).child(k.n)))
                .id(`tk-${i}`)
            )
          ),
          (el) => el.loop("left", { from: -240, to: 0, period: 28000 })
        )
      )
      .child(h_flex().absolute().top(0).left(0).size_full().justify_center().child(icon("tri", 10, C.cyan)));

    const readout = (name, value, color, extra) =>
      h_flex().gap(6).items_center().child(label(name, C.muted, 11.5)).child(extra ? extra(mono(value, color, 12.5)) : mono(value, color, 12.5));

    return h_flex()
      .id("bar")
      .size_full()
      .relative()
      .items_center()
      .pl(mac ? 84 : 16)
      .pr(14)
      .on_size_change((size) => { if (Math.abs(size.width - (this.width ?? 0)) > 8) { const before = this.width; this.width = size.width; this.fit(size.width, before); } })
      .border_b(1)
      .border_color("#ffb5472e")
      .bg("#08090b")
      .child(div().font_family(HUD).font_weight(700).text_size(15).text_color(C.amber).whitespace_nowrap().child(track("Herdr // Cockpit")))
      .child(tape)
      .child(
        h_flex().gap(16).items_center().flex_none()
          .child(div().id("active").tooltip(`${awake} working of ${list.length} agents${cryo.length ? `, ${cryo.length} asleep` : ""}`).child(readout("Active", `${awake}/${list.length + cryo.length}`, C.ink)))
          .child(
            div().id("caution").cursor_pointer()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .tooltip(blocked.length ? "Go to the agent that needs you" : "Nothing needs you · show the left panels")
              .on_click(() => (blocked[0] ? run("agent.focus", { terminal: blocked[0].address }) : run("layout.show", { id: "c-left" })))
              .child(readout("Caution", String(blocked.length), blocked.length ? C.red : C.dim, (el) => (blocked.length ? blink(el, 1000) : el)))
          )
          .when(Boolean(fuel), (el) => el.child(div().id("fuel").tooltip(`Fullest plan limit: ${fuel.name} at ${fuel.pct}% used`).child(readout("Used", `${fuel.pct}%`, fuelColor(fuel.pct, C)))))
          .child(mono(`${pad(now.getHours())}:${pad(now.getMinutes())}`, C.cyan, 13))
          .child(div().w(1).h(18).bg("#ffb54733"))
          .child(h_flex().gap(4)
            .child(this.toggle("c-left", "Show / hide Agents and Sessions"))
            .child(this.toggle("c-right", "Show / hide Plan limits, Pull requests and Resources"))
            .child(
              div().id("tg-motion").w(30).h(26).flex().items_center().justify_center().border(1)
                .border_color(motionSetting() ? "#5ce1e666" : "#5ce1e622")
                .bg(motionSetting() ? "#5ce1e61a" : "#00000000")
                .cursor_pointer().hover((s) => s.bg("#5ce1e62e"))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click(() => setShared("cockpit.motion", !motionSetting()))
                .tooltip(motionSetting() ? "Motion on (pauses while the window is in the background)" : "Motion off")
                .child(icon("motion", 14, motionSetting() ? C.cyan : C.dim))
            ))
      );
  }
}
