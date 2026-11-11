// Cryo: quit a space's agents and keep how to resume each one, then wake them
// with the same conversation. Only agents with a known resume id are touched:
// Claude Code (~/.claude/sessions/<pid>.json) and Codex (its open rollout file).

import { agents, exec, hc, home, readTextFile, run, shared, setShared, notify, machines, spaces } from "herdr";

const KEY = "telemetry.cryo";
export const sleepers = () => (Array.isArray(shared(KEY)) ? shared(KEY) : []);
const save = (list) => setShared(KEY, list);

async function getTerminal(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const SHELLS = /(^|\/)-?(zsh|bash|fish|sh|dash|ksh|nu|pwsh|xonsh)$/;
const isShell = (fg) => Boolean(fg && SHELLS.test(fg.argv?.[0] ?? fg.name ?? ""));

async function resumeFor(agent, fg, machine) {
  if (!fg?.pid) return null;
  if (agent.app === "claude-code" || agent.program?.key === "claude") {
    const text = await readTextFile(`${home()}/.claude/sessions/${fg.pid}.json`, { on: machine });
    const id = text ? JSON.parse(text).sessionId : null;
    return id && /^[\w-]+$/.test(id) ? { app: "claude", cmd: `claude --resume ${id}`, id } : null;
  }
  if (agent.app === "codex" || agent.program?.key === "codex") {
    // Codex keeps its session's rollout file open; its children may hold it instead.
    const kids = await exec("pgrep", ["-P", String(fg.pid)], { on: machine }).catch(() => ({ stdout: "" }));
    const pids = [String(fg.pid), ...kids.stdout.split(/\s+/).filter(Boolean)].join(",");
    const r = await exec("lsof", ["-Fn", "-p", pids], { on: machine }).catch(() => ({ stdout: "" }));
    const m = r.stdout.match(/rollout-[\dT:-]+-([0-9a-f-]{36})\.jsonl/);
    return m ? { app: "codex", cmd: `codex resume ${m[1]}`, id: m[1] } : null;
  }
  return null;
}

/**
 * What cryo would do for each agent in a space: { agent, plan } with plan null when it
 * can't be resumed (it stays awake). Read fresh right before freezing.
 */
export async function survey(space) {
  const out = [];
  for (const a of agents().filter((x) => x.space === space.id)) {
    const t = await getTerminal(a.address);
    const fg = t?.foreground;
    const plan = isShell(fg) ? null : await resumeFor(a, fg, space.machine).catch(() => null);
    out.push({ agent: a, fg, plan, cwd: fg?.cwd ?? t?.cwd ?? null });
  }
  return out;
}

/** Quits each resumable agent in the space (SIGTERM to the agent, the shell stays). */
export async function freeze(space, rssOf) {
  const plans = await survey(space);
  const list = sleepers();
  let n = 0;
  for (const p of plans) {
    if (!p.plan || list.some((s) => s.address === p.agent.address)) continue;
    const k = await exec("kill", ["-TERM", String(p.fg.pid)], { on: space.machine }).catch(() => ({ code: 1 }));
    if (k.code !== 0) continue;
    list.push({
      address: p.agent.address, space: space.id, tab: p.agent.tab, machine: space.machine ?? null,
      app: p.plan.app, cmd: p.plan.cmd, cwd: p.cwd, title: p.agent.title, at: Date.now(),
      rss: rssOf?.(p.fg.pid) ?? 0,
    });
    n++;
  }
  save(list);
  const skipped = plans.filter((p) => !p.plan).length;
  if (n || skipped) notify({ title: n ? `Cryo: ${n} agent${n > 1 ? "s" : ""} asleep` : "Cryo: nothing to put to sleep", body: skipped ? `${skipped} kept awake (no resume id)` : undefined, level: n ? "info" : "warning", timeout: 4000 });
  return n;
}

/** Resumes a space's sleepers: in their own shell if it's free, else in a new tab. */
export async function wake(spaceId) {
  const list = sleepers();
  const mine = list.filter((s) => s.space === spaceId);
  const failed = [];
  for (const s of mine) {
    try {
      const t = await getTerminal(s.address);
      if (t?.state === "live" && isShell(t.foreground)) {
        const r = await hc(["send", s.address, s.cmd]);
        if (r.code !== 0) throw new Error(r.stderr || "send failed");
      } else if (!t || t.state !== "live") {
        const [bin, ...args] = s.cmd.split(" ");
        run("tab.new", { space: spaceId, folder: s.cwd ?? undefined, argv: [bin, ...args] });
      }
      // A terminal busy with something else: someone resumed it already; just forget it.
    } catch {
      failed.push(s);
    }
  }
  // Keep the ones that didn't wake, with their resume command, and say how to do it by hand.
  save([...sleepers().filter((s) => s.space !== spaceId), ...failed]);
  if (failed.length) notify({ title: "Wake failed", body: failed.map((s) => s.cmd).join("\n"), level: "error", timeout: 12000 });
  return mine.length - failed.length;
}

/** Drops sleepers whose space is gone (only once this machine's spaces have loaded). */
export function prune(spaceIds) {
  const local = machines().find((m) => m.name == null);
  if (local?.layout !== "ready" || !spaces().length) return;
  const list = sleepers();
  const keep = list.filter((s) => spaceIds.has(s.space));
  if (keep.length !== list.length) save(keep);
}
