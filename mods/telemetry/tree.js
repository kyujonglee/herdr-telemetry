// Session tree for Sessions: which sessions an agent is running under it.
//   - Herdr sub-agents: a terminal an agent started with `hc run` has it as `parent`.
//   - Claude Code sessions it directs: the ones a Claude Code agent sent `SendMessage`
//     to (its transcript), matched by name to the live sessions in ~/.claude/sessions
//     on that machine. Those may run outside Herdr (Claude Desktop, another terminal):
//     they're shown by name and status; one that is a Herdr agent is nested itself.
//     A background one (`claude --bg`) can be opened in a tab with `claude attach <id>`;
//     a Herdr terminal running that attach counts as the session's Herdr agent.
// One level deep. Read on each agent's own machine; nothing is written. A transcript
// (tens of MB after a long session) is searched whole once, then only what was added.

import { terminals, spaces, exec, hc, home } from "herdr";
import { transcriptPath } from "./data.js";

const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";
const SENT = '"name":"SendMessage","input":{"to":"[^"]*"';
const MAX = 8; // children shown per parent
// Prints a transcript's size and where the search began, then the SendMessage targets
// from there on: from a little before its last size ($2; a line may have been half
// written then), or from the start if the file got smaller. As bytes (LC_ALL=C): a
// read that starts inside a character must not make grep call the rest binary.
const SCAN = '[ -f "$1" ] || exit 1; n=$(($(wc -c < "$1"))); from=$(($2 - 512)); [ "$from" -lt 0 ] && from=0; [ "$n" -lt "$2" ] && from=0; '
  + 'echo "$n $from"; if [ "$from" -eq 0 ]; then LC_ALL=C grep -o "$3" "$1"; else tail -c +"$((from + 1))" "$1" | LC_ALL=C grep -o "$3"; fi';

/** One machine's live Claude Code sessions: pid → { pid, sessionId, cwd, name, status, at }. */
async function liveSessions(on) {
  const opts = on ? { on, timeout: 5000 } : { cwd: home(), timeout: 5000 };
  const r = await exec("sh", ["-c", 'for f in .claude/sessions/*.json; do cat "$f"; echo; done'], opts).catch(() => null);
  const all = [];
  for (const line of (r?.stdout ?? "").split("\n")) {
    try { const s = JSON.parse(line); if (Number.isInteger(s?.pid)) all.push(s); } catch {}
  }
  if (!all.length) return new Map();
  const ps = await exec("ps", ["-o", "pid=", "-p", all.map((s) => s.pid).join(",")], opts).catch(() => null);
  const alive = new Set((ps?.stdout ?? "").split(/\s+/).filter(Boolean).map(Number));
  return new Map(all.filter((s) => alive.has(s.pid)).map((s) => [s.pid, {
    pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name ?? null,
    status: s.status ?? null, at: s.statusUpdatedAt ?? s.updatedAt ?? null,
    kind: s.kind ?? null, entrypoint: s.entrypoint ?? null,
  }]));
}

/** The id `claude attach` takes for a background session (its session id's first 8).
 *  Only a plain id: it's typed into a shell. */
export const attachId = (sessionId) => (/^[\w-]+$/.test(String(sessionId ?? "")) ? String(sessionId).slice(0, 8) : "");

/** The names a transcript sent `SendMessage` to, most recent first, each once.
 *  `sent` keeps transcript → { size, names } between reads. */
async function sentTo(rel, opts, sent) {
  const was = sent.get(rel) ?? { size: 0, names: [] };
  const g = await exec("sh", ["-c", SCAN, "sh", rel, String(was.size), SENT], opts).catch(() => null);
  const [head, ...lines] = (g?.stdout ?? "").split("\n");
  const [size, from] = head.split(" ").map(Number);
  if (!Number.isInteger(size) || !Number.isInteger(from)) return was.names;
  const found = lines.map((l) => l.match(/"to":"([^"]*)"$/)?.[1]).filter(Boolean).reverse();
  const names = [...new Set([...found, ...(from ? was.names : [])])];
  sent.set(rel, { size, names });
  return names;
}

/** The `claude attach <id>` a terminal's foreground runs, if any. */
export function attachOf(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const i = a.indexOf("attach");
  return i >= 0 && /claude$/.test(String(a[i - 1] ?? "")) ? String(a[i + 1] ?? "") || null : null;
}

/**
 * The tree for these agents: { kids: Map(parent address → [child]), under: Map(child address → parent address) }.
 * A child is { address } for a Herdr agent, else { name, status, at, cwd }.
 * `pids` caches terminal address → foreground pid between reads, `sent` what each
 * transcript was found to message (see sentTo).
 */
export async function readTree(list, pids, sent) {
  const kids = new Map();
  const under = new Map();
  const add = (parent, child) => {
    const k = kids.get(parent) ?? [];
    if (k.length >= MAX) return; // the rest keep their own rows
    k.push(child);
    kids.set(parent, k);
    if (child.address) under.set(child.address, parent);
  };
  const shown = new Set(list.map((a) => a.address));

  // Herdr's own: hc run from inside an agent. A sub-agent's own sub-agents go under the
  // same top agent (one level): under a row that is itself nested they'd be shown nowhere.
  const parentOf = new Map(terminals().map((t) => [String(t.address), t.parent ? String(t.parent) : null]));
  for (const a of list) {
    let top = null;
    let p = parentOf.get(a.address);
    const seen = new Set([a.address]);
    while (p && shown.has(p) && !seen.has(p)) { top = p; seen.add(p); p = parentOf.get(p); }
    if (top && !seen.has(p)) add(top, { address: a.address }); // a loop of parents: nobody's child
  }

  // Claude Code: who each one messages, per machine.
  const byMachine = new Map();
  for (const a of list.filter(isClaude)) {
    const on = spaces().find((s) => s.id === a.space)?.machine ?? null;
    const k = on ?? "";
    if (!byMachine.has(k)) byMachine.set(k, []);
    byMachine.get(k).push(a);
  }
  for (const [k, group] of byMachine) {
    const on = k || null;
    const sessions = await liveSessions(on);
    if (!sessions.size) continue;
    const opts = on ? { on, timeout: 5000 } : { cwd: home(), timeout: 5000 };
    // Herdr agent ↔ its Claude session, by the agent's foreground pid.
    const agentOf = new Map(); // pid → agent address
    for (const a of group) {
      let pid = pids.get(a.address);
      if (!sessions.has(pid)) {
        const g = await hc(["get", a.address, "--json"]).catch(() => null);
        let fg = null;
        try { fg = JSON.parse(g?.stdout ?? "")?.foreground ?? null; } catch {}
        pid = fg?.pid ?? null;
        // `claude attach <id>`: the session runs elsewhere (its own pid); this is its window.
        const id = attachOf(fg?.argv);
        const s = id && [...sessions.values()].find((x) => x.sessionId?.startsWith(id));
        if (s) pid = s.pid;
        if (pid) pids.set(a.address, pid);
      }
      if (sessions.has(pid)) agentOf.set(pid, a.address);
    }
    const byName = new Map();
    for (const s of sessions.values()) if (s.name && !byName.has(s.name)) byName.set(s.name, s);
    for (const [pid, address] of agentOf) {
      if (under.has(address)) continue; // already someone's child: one level
      const me = sessions.get(pid);
      const rel = transcriptPath(me.cwd, me.sessionId);
      if (!rel) continue;
      for (const n of await sentTo(rel, opts, sent)) {
        const s = byName.get(n);
        if (!s || s.pid === pid) continue;
        const herdr = agentOf.get(s.pid);
        if (herdr && (under.has(herdr) || kids.has(herdr))) continue;
        add(address, herdr ? { address: herdr } : { name: s.name, status: s.status, at: s.at, cwd: s.cwd, sessionId: s.sessionId, kind: s.kind, entrypoint: s.entrypoint });
      }
    }
  }
  return { kids, under };
}
