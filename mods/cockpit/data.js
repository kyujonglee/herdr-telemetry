// Pure parsers for what the cockpit reads: agent screens, plan limits, pull requests.
// No herdr or gpui imports, so each one can be tried on recorded text.

// ---- agent screens (`hc read`)

const BOX = /^[\s│┃|╭╮╰╯─━┌┐└┘├┤┬┴┼▌▐]+$/;
const strip = (l) => l.replace(/[│┃]/g, " ").replace(/\s+$/, "");

/**
 * What a waiting agent is saying: Claude Code's `※ recap:` line, its last
 * message, and a numbered choice it's asking (only a clean 1..n run counts).
 */
export function parseScreen(text) {
  const lines = String(text ?? "").split("\n").map(strip);
  let recap = null;
  for (let i = lines.length - 1; i >= 0 && !recap; i--) {
    const m = lines[i].match(/^\s*※\s*recap:\s*(.*)$/);
    if (!m) continue;
    let s = m[1];
    // Wrapped lines follow indented; the recap ends at its "(disable recaps …)"
    // note, and right-aligned status lines (far-indented) are not part of it.
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s{20,}/.test(lines[j]) && !/\(disable recaps/.test(s); j++) s += " " + lines[j].trim();
    recap = s.replace(/\s*\(disable recaps in \/config\)[\s\S]*$/, "").trim();
  }

  // The last thing it said in prose: a ⏺ / • / ● line that isn't a tool call.
  let last = null;
  for (let i = lines.length - 1; i >= 0 && !last; i--) {
    const m = lines[i].match(/^\s*[⏺•]\s+(.+)$/);
    // A tool call shows its output under it (⎿): that's not prose.
    const tool = /^\s*⎿/.test(lines[i + 1] ?? "") || /^\s*⎿/.test(lines[i + 2] ?? "");
    if (m && !tool && !/^[\w.-]+\(/.test(m[1]) && !/^(Read|Bash|Update|Write|Edit|Search|List)\b/.test(m[1])) {
      // Its paragraph: the wrapped lines that follow, indented, up to a blank line.
      let t = m[1].trim();
      for (let j = i + 1; j < lines.length && j <= i + 8 && /^\s{2,}\S/.test(lines[j]) && !/^\s*[⏺•●※❯>⎿]/.test(lines[j]); j++) t += " " + lines[j].trim();
      last = t;
    }
  }

  // A numbered choice near the bottom: 1., 2., … in order, with the question above it.
  let options = null;
  let question = null;
  let context = [];
  const tail = Math.max(0, lines.length - 40);
  for (let end = lines.length - 1; end >= tail && !options; end--) {
    const opt = (l) => l.match(/^\s*(?:[❯›>▶]\s*)?(\d)[.)]\s+(.+?)\s*$/);
    const m = opt(lines[end]);
    if (!m) continue;
    // Walk up collecting a contiguous run (continuation lines may sit between).
    const found = [];
    let i = end;
    for (; i >= tail; i--) {
      const o = opt(lines[i]);
      if (o) found.unshift({ key: o[1], text: o[2], selected: /^\s*[❯›>▶]/.test(lines[i]) });
      else if (lines[i].trim() === "" || BOX.test(lines[i])) break;
      else if (!/^\s{3,}\S/.test(lines[i])) break;
    }
    const ok = found.length >= 2 && found.length <= 9 && found.every((o, k) => o.key === String(k + 1));
    if (!ok) break;
    options = found;
    // The question is the nearest line above; what it's about (the command, the file)
    // is the rest of its box above that, up to 8 lines, stopping at the box's top edge.
    const above = [];
    let blanks = 0;
    for (let k = i; k >= tail && above.length < 9; k--) {
      const raw = lines[k];
      if (BOX.test(raw) && raw.trim()) break;
      const l = raw.trim();
      if (!l) { if (above.length && ++blanks >= 2) break; continue; }
      blanks = 0;
      above.unshift(l);
    }
    question = above.pop() ?? null;
    context = above.slice(-8);
  }
  // Failing prose, the latest step it ran (a tool call's own line), e.g. "Bash(npm test)".
  let action = null;
  for (let i = lines.length - 1; i >= 0 && !action; i--) {
    const m = lines[i].match(/^\s*⏺\s+(.+)$/);
    if (m) action = m[1].trim();
  }
  return { recap, last, action, question, context, options };
}

/** True when two parses offer the same choice (re-read before pressing a key). */
export const sameChoice = (a, b) =>
  Boolean(a?.options && b?.options) &&
  a.question === b.question &&
  (a.context ?? []).join("\n") === (b.context ?? []).join("\n") &&
  a.options.length === b.options.length &&
  a.options.every((o, i) => o.text === b.options[i].text);

// ---- plan limits

const WINDOW = { session: 300, weekly_all: 10080, weekly_scoped: 10080 };

/** Claude Code's get_usage control_response → tapes. */
export function claudeTapes(line, now = Date.now()) {
  const r = JSON.parse(line)?.response?.response?.rate_limits;
  if (!r) throw new Error("no rate_limits");
  const out = [];
  const limits = Array.isArray(r.limits) ? r.limits : [];
  const session = limits.find((l) => l.kind === "session");
  // No session window yet means nothing used in the last five hours.
  out.push(session ? tape("CL 5H", session.percent, Date.parse(session.resets_at), 300, now) : { name: "CL 5H", pct: 0, pace: null, reset: null, quiet: true });
  const weekly = limits.find((l) => l.kind === "weekly_all");
  if (weekly) out.push(tape("CL 7D", weekly.percent, Date.parse(weekly.resets_at), 10080, now));
  for (const l of limits.filter((l) => l.kind === "weekly_scoped" && l.is_active !== false)) {
    out.push({ ...tape(`CL ${(l.scope?.model?.display_name ?? "MODEL").slice(0, 5)}`, l.percent, Date.parse(l.resets_at), WINDOW[l.kind], now), model: l.scope?.model?.display_name ?? null });
  }
  for (const t of out) { t.provider = "claude"; t.win = t.model ? `Weekly · ${t.model}` : t.name === "CL 5H" ? "5-hour" : "Weekly"; }
  return out;
}

/** Codex app-server account/rateLimits/read (or a session log's rate_limits) → tapes. */
export function codexTapes(line, now = Date.now()) {
  const j = JSON.parse(line);
  const r = j?.limits?.result?.rateLimits ?? j?.result?.rateLimits ?? j?.rate_limits ?? j?.payload?.rate_limits;
  if (!r) throw new Error("no rateLimits");
  const out = [];
  for (const w of [r.primary, r.secondary]) {
    if (!w) continue;
    const mins = w.windowDurationMins ?? w.window_minutes;
    const pct = w.usedPercent ?? w.used_percent;
    const resets = (w.resetsAt ?? w.resets_at) * 1000;
    const t = tape(`CX ${mins >= 1440 ? `${Math.round(mins / 1440)}D` : `${Math.round(mins / 60)}H`}`, pct, resets, mins, now);
    t.provider = "codex";
    t.win = mins >= 10080 ? "Weekly" : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
    out.push(t);
  }
  return out;
}

function tape(name, pct, resetsAt, windowMins, now) {
  const leftMs = resetsAt - now;
  // A window that already reset reads as empty until the next answer.
  if (leftMs <= 0) return { name, pct: 0, pace: null, reset: null, quiet: true };
  const pace = windowMins ? Math.min(100, Math.max(0, 100 - (leftMs / (windowMins * 60000)) * 100)) : null;
  return { name, pct: Math.round(Number(pct) || 0), pace, reset: leftMs, quiet: false };
}

/** Who the limits belong to: { email, plan }. Claude: `claude auth status --json`; Codex: the helper's account/read reply. */
export function claudeAccount(text) {
  const j = JSON.parse(text);
  return j?.loggedIn ? { email: j.email ?? null, plan: j.subscriptionType ?? null } : null;
}
export function codexAccount(line) {
  const a = JSON.parse(line)?.account?.result?.account;
  return a ? { email: a.email ?? null, plan: a.planType ?? null } : null;
}

export const fuelColor = (pct, C) => (pct >= 90 ? C.red : pct >= 70 ? C.amber : C.cyan);

// ---- pull requests (`gh pr list --json`)

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function checks(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  let pass = 0, fail = 0, run = 0;
  for (const c of list) {
    const verdict = c.conclusion || c.state;
    if (c.status && c.status !== "COMPLETED") run++;
    else if (PASS.has(verdict)) pass++;
    else if (FAIL.has(verdict)) fail++;
    else if (verdict === "PENDING" || verdict === "EXPECTED") run++;
    else pass++;
  }
  return { pass, fail, run, total: list.length };
}

/** A PR's five stages: open → checks → review → merge → deploy, each ok | run | wait | fail | skip. */
export function stages(pr, deploy) {
  const ck = checks(pr.statusCheckRollup);
  const merged = pr.state === "MERGED";
  const s = [];
  s.push({ name: "OPEN", s: pr.isDraft ? "wait" : "ok", detail: pr.isDraft ? "draft" : merged ? "merged" : "ready" });
  s.push({
    name: "CHECKS",
    s: ck.total === 0 ? "skip" : ck.fail ? "fail" : ck.run ? "run" : "ok",
    detail: ck.total === 0 ? "none" : ck.fail ? `${ck.fail} failing` : `${ck.pass}/${ck.total}`,
  });
  const rd = pr.reviewDecision;
  s.push({
    name: "REVIEW",
    s: merged || rd === "APPROVED" ? "ok" : rd === "CHANGES_REQUESTED" ? "fail" : rd === "REVIEW_REQUIRED" ? "wait" : "skip",
    detail: rd === "APPROVED" ? "approved" : rd === "CHANGES_REQUESTED" ? "changes" : rd === "REVIEW_REQUIRED" ? "waiting" : merged ? "—" : "not required",
  });
  const ms = pr.mergeStateStatus;
  s.push({
    name: "MERGE",
    s: merged ? "ok" : ms === "DIRTY" ? "fail" : ms === "CLEAN" || ms === "HAS_HOOKS" || ms === "UNSTABLE" ? "ready" : "wait",
    detail: merged ? "docked" : ms === "DIRTY" ? "conflict" : ms === "BEHIND" ? "behind" : ms === "CLEAN" ? "ready" : (ms ?? "—").toLowerCase(),
  });
  if (!merged) s.push({ name: "DEPLOY", s: "wait", detail: "after merge" });
  else if (!deploy || deploy.total === 0) s.push({ name: "DEPLOY", s: "skip", detail: "no runs" });
  else s.push({ name: "DEPLOY", s: deploy.fail ? "fail" : deploy.run ? "run" : "ok", detail: deploy.fail ? `${deploy.failName ?? "failed"}` : deploy.run ? `${deploy.runName ?? "running"}` : "landed" });
  return s;
}

/**
 * What ran on a merge commit → a deploy summary. `list`: `gh run list --commit … --json
 * name,status,conclusion` (Actions); `statuses`: the commit's combined status
 * (`gh api repos/{owner}/{repo}/commits/<sha>/status`), where Vercel and others report.
 */
export function runs(list, statuses) {
  const out = { total: 0, run: 0, fail: 0, runName: null, failName: null };
  for (const r of Array.isArray(list) ? list : []) {
    out.total++;
    if (r.status !== "completed") { out.run++; out.runName ??= r.name; }
    else if (FAIL.has(String(r.conclusion).toUpperCase())) { out.fail++; out.failName ??= r.name; }
  }
  for (const st of Array.isArray(statuses) ? statuses : []) {
    out.total++;
    const state = String(st.state).toLowerCase();
    if (state === "pending") { out.run++; out.runName ??= st.context; }
    else if (state === "failure" || state === "error") { out.fail++; out.failName ??= st.context; }
  }
  return out;
}

/** One-word verdict for a compact PR row. */
export function verdict(st) {
  if (st.some((x) => x.s === "fail")) return { word: "fix needed", tone: "fail", why: st.find((x) => x.s === "fail").detail };
  const d = st[st.length - 1];
  if (d.s === "ok") return { word: "deployed", tone: "ok", why: "" };
  if (st.some((x) => x.s === "run")) return { word: "in flight", tone: "run", why: st.find((x) => x.s === "run").name.toLowerCase() };
  if (st[3].detail === "docked") return { word: "merged", tone: "ok", why: d.s === "skip" ? "no deploy seen" : "" };
  if (st[3].s === "ready") return { word: "ready to merge", tone: "ok", why: "" };
  return { word: "holding", tone: "wait", why: st.find((x) => x.s === "wait")?.name.toLowerCase() ?? "" };
}
