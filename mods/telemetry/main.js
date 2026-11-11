// Telemetry: a flight-HUD layout for Herdr, one mod in roles. The layout gives
// each copy props { role, block, open }:
//   bar      the title bar: heading tape, active / caution / used, clock, column switches
//   tabs     spaces and the shown space's tabs, above the terminals
//   radar    agents as blips, nearer the center the more they need you, with counts
//   caution  sessions: what each agent is doing; ones asking you first, with their choices
//   dock     pull requests as docking stages: open, checks, review, merge, deploy
//   fuel     Claude Code and Codex plan limits as gauges, per account (and machine)
//   reactor  CPU and memory per space, and Cryo / Wake
// `block` is the role's layout node (its title strip folds it), `open` its unfolded size.
// Without a role (as `herdr-app check` loads it) every role draws, for a look at all of them.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props } from "herdr";
import Bar from "./bar.js";
import Tabs from "./tabs.js";
import Radar from "./radar.js";
import Caution from "./caution.js";
import Dock from "./dock.js";
import Fuel from "./fuel.js";
import Reactor from "./reactor.js";
import { C } from "./hud.js";

const ROLES = { bar: Bar, tabs: Tabs, radar: Radar, caution: Caution, dock: Dock, fuel: Fuel, reactor: Reactor };
const SAMPLE = { bar: [1100, 48], tabs: [760, 34], radar: [300, 190], caution: [300, 640], dock: [300, 460], fuel: [300, 250], reactor: [300, 230] };

export default class Telemetry extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    if (pr.role) {
      const R = ROLES[pr.role];
      this.role = R ? new R() : null;
      this.role?.init?.(pr, cx);
      this.missing = !R && pr.role;
      return;
    }
    this.all = Object.entries(ROLES).map(([name, R]) => {
      const r = new R();
      r.init?.({ role: name }, cx);
      return [name, r];
    });
  }

  render(cx) {
    if (this.all)
      return v_flex().size_full().gap(12).p(12).bg(C.bg).overflow_y_scrollbar().id("telemetry-all").children(
        this.all.map(([name, r]) => div().w(SAMPLE[name][0]).h(SAMPLE[name][1]).flex_none().child(r.render(cx)))
      );
    if (!this.role) return div().text_color(C.red).child(`telemetry: no role "${this.missing}"`);
    return this.role.render(cx);
  }
}
