// The strip above the terminals: every space as a chip, then the shown space's
// tabs as numbered HUD tabs. Works like Herdr's own tab bar: + opens a "new" menu
// (a terminal or any installed agent, e.g. Claude Code, in a folder you pick: launch.js), a double
// click renames, right click opens the tab menu, the wheel switches tabs, × closes.
// The focused pane's git branch sits at the right (its folder is in the pane's own
// header). Narrow strips drop the branch first, then shorten space chips to 3 letters.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, focused, panes, run, openOverlay } from "herdr";
import { C, HUD, MONO, track, icon, move, blink, STATUS, shortName } from "./hud.js";

const stop = (_e, cx) => cx.stop_propagation();

const dot = (status, size = 6) => {
  const c = status ? STATUS[status]?.c ?? C.dim : C.faint;
  const d = div().w(size).h(size).flex_none().bg(c);
  return status === "blocked" ? blink(d, 1200) : d;
};

export default class Tabs {
  init() {
    this.width = 900;
  }

  render() {
    const all = spaces();
    const space = all.find((s) => s.active);
    const tabs = (space?.tabs ?? []).filter((t) => !t.settled || t.active);
    const f = focused();
    const pane = panes().find((p) => p.pane === f?.pane);
    const w = this.width;
    const showWhere = w > 980 && Boolean(pane?.branch);
    const compactSpaces = w < 760 || all.length > 4;

    const chip = (s) => {
      const name = s.name === "/" || !s.name ? (s.machine ?? "home") : s.name;
      return h_flex().id(`sp-${s.id}`).h(24).px(8).gap(6).items_center().flex_none().cursor_pointer()
        .border(1).border_color(s.active ? "#5ce1e666" : "#00000000")
        .bg(s.active ? "#5ce1e614" : "#00000000")
        .hover((st) => st.bg("#5ce1e61f"))
        .tooltip(`Space: ${name}${s.machine ? ` (on ${s.machine})` : ""} — double-click to rename`)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.click_count === 2) run("space.rename", { id: s.id }); })
        .on_click(() => run("space.select", { id: s.id }))
        .child(dot(s.status))
        .child(div().font_family(HUD).font_weight(700).text_size(12).text_color(s.active ? C.cyanHi : C.muted).whitespace_nowrap()
          .child(track(compactSpaces && !s.active ? shortName(name) : name)));
    };

    const tab = (t) =>
      h_flex().id(`tb-${t.id}`).h(26).pl(9).pr(t.active ? 4 : 9).gap(7).items_center().cursor_pointer()
        .min_w(t.active ? 96 : 56).flex_shrink(t.active ? 0 : 1).overflow_hidden()
        .border(1).border_color(t.active ? "#ffb54788" : "#00000000")
        .bg(t.active ? "#ffb54714" : "#00000000")
        .hover((st) => st.bg("#ffb5471f"))
        .tooltip(`${t.name} — double-click to rename, right-click for more`)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.click_count === 2) run("tab.rename", { id: t.id }); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: t.id, space: space.id } } }); })
        .on_click(() => run("tab.select", { id: t.id }))
        .child(div().font_family(MONO).text_size(10.5).text_color(t.active ? C.amber : C.dim).flex_none().child(String(t.index).padStart(2, "0")))
        // Tab names are read, not decoration: no tracking, so more of them fit.
        .child(div().text_size(12.5).font_weight(t.active ? 700 : 600).text_color(t.active ? C.amberHi : C.muted).min_w(0).max_w(170).truncate().child(t.name))
        .when(Boolean(t.status), (el) => el.child(dot(t.status, 5)))
        .when(t.active, (el) => el.child(
          div().id(`close-${t.id}`).w(18).h(18).flex().flex_none().items_center().justify_center().text_color(C.dim)
            .hover((st) => st.text_color(C.amber).bg("#ffb5471f")).tooltip("Close tab")
            .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: t.id }); })
            .child(svg("mods/pane/close.svg").size(11))));

    const plus = (id, tip, action) =>
      div().id(id).w(24).h(24).flex().flex_none().items_center().justify_center().cursor_pointer()
        .border(1).border_color("#ffb54744").hover((st) => st.bg("#ffb5471f"))
        .tooltip(tip).on_mouse_down("left", stop).on_click(action).child(icon("plus", 10, C.amber));

    return h_flex()
      .id("tabs")
      .size_full()
      .px(8)
      .gap(6)
      .items_center()
      .bg("#0a0b0d")
      .border(1)
      .border_color("#ffb54722")
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 8) { this.width = size.width; cx.notify(); } })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().gap(3).items_center().flex_none().children(all.map(chip)))
      .child(plus("new-space", "New space", () => run("space.new", {})))
      .child(div().w(1).h(18).mx(4).flex_none().bg("#ffb54733"))
      .child(h_flex().gap(3).items_center().min_w(0).flex_shrink(1).overflow_hidden().children(tabs.map(tab)))
      .child(plus("new-tab", "New tab: a terminal or an agent (Claude Code, Codex, …)", () => openOverlay({ mod: "telemetry", kind: "popup", width: 400, height: 640, props: { role: "launch" } })))
      .child(div().flex_1().min_w(0))
      .when(showWhere, (el) =>
        el.child(div().id("branch").min_w(0).max_w(Math.round(w * 0.3)).flex_shrink(8).font_family(MONO).text_size(10.5).text_color(C.muted).truncate()
          .tooltip("Git branch of the focused pane").child(`⎇ ${pane.branch}`))
      );
  }
}
