// Pure parsers for what the telemetry reads: agent screens, plan limits, pull requests.
// No herdr or gpui imports, so each one can be tried on recorded text.

// ---- agent screens (`hc read`)

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

  // Failing prose, the latest step it ran (a tool call's own line), e.g. "Bash(npm test)".
  let action = null;
  for (let i = lines.length - 1; i >= 0 && !action; i--) {
    const m = lines[i].match(/^\s*⏺\s+(.+)$/);
    if (m) action = m[1].trim();
  }
  return { recap, last, action, menu: readMenu(text) };
}

// ---- a waiting agent's menu
// Ported from herdr-relevo's `lib/prompt.js` (Apache-2.0, https://github.com/johnny4young/herdr-relevo),
// by way of quaresc/cockpit's prompt.rs (MIT, https://github.com/quaresc/cockpit); its key sequences were measured on Claude Code's menus.
// Modified: translated to plain JS for this mod, plus the box text above the question.

const OPTION = /^([❯›>]\s*)?(\d)\.\s+(.+?)\s*$/;
const SUBMIT = /^([❯›>]\s*)?(Submit|Submit answers)$/i;
const CHECK = /^\[([ xX✔✓✗])?\]\s*/;
const FRAME = /^[│┃╭╮╰╯─━┌┐└┘|\s]+|[│┃╭╮╰╯─━┌┐└┘|\s]+$/g;
const BESIDE = /\s{3,}[┌│└╭╰].*$/;
const MAX_GAP = 4; // lines between two choices that still belong to the menu
const TABS = (l) => l.startsWith("←") && l.endsWith("→");

/**
 * The menu at the bottom of a screen: { text, kind: single | multi | text, choices: [{ n, label,
 * detail, checked, free }], cursor: n | "submit" | null, submitAfter, free, permission, context }.
 * `context` is what the question is about (the command, the file): the box text above it.
 */
export function readMenu(screen) {
  const all = String(screen ?? "").split("\n").map((l) => l.replace(FRAME, ""));
  const lines = all.slice(-60);
  const kept = lines.map((l) => l.trim()).filter((l) => l && !TABS(l));
  const none = { text: kept.slice(-2).join("\n"), kind: "text", choices: [], cursor: null, submitAfter: null, free: null, permission: false, context: [] };
  let last = -1;
  for (let i = lines.length - 1; i >= 0 && last < 0; i--) if (OPTION.test(lines[i])) last = i;
  if (last < 0) return none;
  const num = (i) => Number(lines[i].match(OPTION)?.[2] ?? 0);
  // Walk up from the last choice to choice 1.
  const found = [[last, num(last)]];
  for (let i = last, gap = 0; i > 0 && found[0][1] > 1 && gap <= MAX_GAP; ) {
    i--;
    if (!OPTION.test(lines[i])) { gap++; continue; }
    if (num(i) !== found[0][1] - 1) break;
    found.unshift([i, num(i)]);
    gap = 0;
  }
  if (found[0][1] !== 1) return none;
  const q = { ...none, kind: "single" };
  found.forEach(([i, n], k) => {
    const m = lines[i].match(OPTION);
    const raw = m[3].replace(BESIDE, "");
    if (m[1]) q.cursor = n;
    const next = k + 1 < found.length ? found[k + 1][0] : Math.min(lines.length, i + 1 + MAX_GAP);
    const detail = [];
    for (const l of lines.slice(i + 1, next).map((l) => l.trim()).filter(Boolean)) {
      const s = l.match(SUBMIT);
      if (s) { q.submitAfter = n; if (s[1]) q.cursor = "submit"; }
      else if (!OPTION.test(l)) detail.push(l);
    }
    const b = raw.match(CHECK);
    q.choices.push({
      n,
      label: b ? raw.slice(b[0].length) : raw,
      detail: k + 1 < found.length ? detail.join(" ") : "",
      checked: b ? Boolean(b[1]) && b[1] !== " " : null,
      free: false,
    });
  });
  if (q.choices.some((c) => c.checked !== null)) q.kind = "multi";
  // The question: the paragraph right above choice 1, two lines at most.
  let i = found[0][0];
  while (i > 0 && !lines[i - 1].trim()) i--;
  const text = [];
  while (i > 0 && text.length < 2) {
    const l = lines[--i].trim();
    if (!l || /^[❯›>]\s/.test(l) || TABS(l) || /^[☐☒]/.test(l)) { i++; break; }
    text.unshift(l);
  }
  q.text = text.join("\n");
  // What it's about: the box text above the question, up to 8 lines.
  const context = [];
  for (let k = i - 1, blanks = 0; k >= 0 && context.length < 8; k--) {
    const l = lines[k].trim();
    if (!l) { if (context.length && ++blanks >= 2) break; continue; }
    if (TABS(l) || /^[☐☒⏺•✻※]/.test(l) || /^[❯›>]\s/.test(l)) break;
    if (/^[─━╌╍┄┅┈┉═\s]+$/.test(l) || /^Tip:/.test(l)) continue; // rules and hints
    blanks = 0;
    context.unshift(l);
  }
  q.context = context;
  // The free-text choice: "Type something", else in a single choice the one before "Chat about this".
  const typed = q.choices.find((c) => /^type something/i.test(c.label));
  const tail = q.choices[q.choices.length - 1];
  q.free = typed?.n ?? (q.kind === "single" && /^chat about this/i.test(tail.label) && tail.n > 1 ? tail.n - 1 : null);
  for (const c of q.choices) c.free = c.n === q.free;
  q.permission = /^do you want to/i.test(q.text) && /^Yes/.test(q.choices[0].label);
  return q;
}

/** The arrow presses from the cursor to choice `to` (null: Submit, which sits right after `submitAfter`). */
export function moveKeys(q, to) {
  const order = q.choices.flatMap((c) => (q.submitAfter === c.n ? [c.n, null] : [c.n]));
  const at = q.cursor === "submit" ? null : q.cursor ?? 1;
  const from = order.indexOf(at);
  const target = order.indexOf(to);
  if (from < 0 || target < 0) return [];
  return Array(Math.abs(target - from)).fill(target > from ? "down" : "up");
}

/** True when two reads show the same menu (re-read before pressing a key). */
export const sameMenu = (a, b) =>
  Boolean(a?.choices?.length && b?.choices?.length) &&
  a.text === b.text &&
  a.kind === b.kind &&
  a.choices.length === b.choices.length &&
  a.choices.every((c, i) => c.label === b.choices[i].label);

// ---- what a waiting Claude Code asks, from its transcript

/** Its transcript, relative to the home folder: ~/.claude/projects/<cwd, every other character a dash>/<session>.jsonl. */
export const transcriptPath = (cwd, session) =>
  /^[\w-]+$/.test(String(session)) && cwd ? `.claude/projects/${String(cwd).replace(/[^A-Za-z0-9]/g, "-")}/${session}.jsonl` : null;

/** The newest tool call without a result in a transcript's tail: { id, name, input }, or null. */
export function pendingTool(text) {
  const uses = [];
  const done = new Set();
  for (const l of String(text ?? "").split("\n")) {
    if (!l.includes('"tool_')) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; } // the first line of a tail is cut
    if (j?.isSidechain) continue;
    const c = j?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === "tool_use") uses.push(b);
      else if (b?.type === "tool_result") done.add(b.tool_use_id);
    }
  }
  for (let i = uses.length - 1; i >= 0; i--) if (!done.has(uses[i].id)) return { id: uses[i].id, name: String(uses[i].name ?? ""), input: uses[i].input ?? {} };
  return null;
}

/**
 * A pending tool call told plainly: { tool, lines, note } for a permission (the whole command,
 * the file), or { questions } for AskUserQuestion.
 */
export function describeTool(t) {
  if (!t) return null;
  const i = t.input ?? {};
  if (t.name === "AskUserQuestion" && Array.isArray(i.questions)) {
    return {
      tool: t.name,
      questions: i.questions.map((q) => ({
        question: String(q.question ?? ""),
        header: String(q.header ?? ""),
        multi: Boolean(q.multiSelect),
        options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })),
      })),
    };
  }
  const lines = (s) => String(s ?? "").split("\n").filter((l) => l.trim());
  if (t.name === "Bash") return { tool: "Bash", lines: lines(i.command).slice(0, 10), note: i.description ?? null };
  if (/^(Edit|MultiEdit|Write|NotebookEdit|Read)$/.test(t.name)) {
    const body = t.name === "Write" ? lines(i.content) : t.name === "Edit" ? lines(i.new_string) : [];
    return { tool: t.name, lines: [i.file_path ?? i.notebook_path ?? "", ...body.slice(0, 4).map((l) => `+ ${l}`)].filter(Boolean), note: null };
  }
  if (t.name === "WebFetch") return { tool: t.name, lines: [i.url ?? ""], note: i.prompt ?? null };
  if (t.name === "WebSearch") return { tool: t.name, lines: [i.query ?? ""], note: null };
  return { tool: t.name, lines: [JSON.stringify(i).slice(0, 400)], note: null };
}

// ---- plan limits

const WINDOW = { session: 300, weekly_all: 10080, weekly_scoped: 10080 };

/** Claude Code's get_usage control_response → tapes. */
export function claudeTapes(line, now = Date.now()) {
  const r = JSON.parse(line)?.response?.response?.rate_limits;
  if (!r) throw new Error("no rate_limits");
  const out = [];
  const limits = Array.isArray(r.limits) ? r.limits : [];
  // \`limits\` is the newer shape; \`five_hour\` / \`seven_day\` say the same when it's missing.
  const legacy = (w) => (w && w.utilization != null && w.resets_at ? { percent: w.utilization, resets_at: w.resets_at } : null);
  const session = limits.find((l) => l.kind === "session") ?? legacy(r.five_hour);
  // No session window yet means nothing used in the last five hours.
  out.push(session ? tape("CL 5H", session.percent, Date.parse(session.resets_at), 300, now) : { name: "CL 5H", pct: 0, pace: null, reset: null, quiet: true });
  const weekly = limits.find((l) => l.kind === "weekly_all") ?? legacy(r.seven_day);
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
