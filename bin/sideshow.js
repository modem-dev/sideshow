#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BASE = (process.env.SIDESHOW_URL ?? "http://localhost:8228").replace(/\/$/, "");
const TOKEN = process.env.SIDESHOW_TOKEN;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// This script's own path — used to register the Stop hook so it works whether
// or not `sideshow` is on PATH (a fresh clone, an npx run, a global install).
const SELF = fileURLToPath(import.meta.url);

const HELP = `sideshow — a live visual surface for terminal coding agents

usage:
  sideshow serve [--port N] [--open]      start the surface (API + viewer)
  sideshow publish <file|-> [options]     publish an HTML post (one html surface)
      --title <t>       post title
      --md <file|->     add a markdown surface (prose) — combine with html
      --mermaid <file|-> add a mermaid surface (diagram source → SVG) — combine with html
      --diff <file|->   add a diff surface from a unified/git patch (combine with html)
      --terminal <file|->  add a terminal surface from monospace/ANSI output
      --json <file|->    add a json surface from a JSON file (collapsible tree)
      --code <file|->    add a code surface from a file (shiki-highlighted)
      --kit <id>        opt the html surface into a kit (repeatable; see "sideshow kits")
      --image <file>    upload an image and append it as an image surface
      --session <id>    target session (default: auto per agent session)
      --session-title <t>  name for a newly created session — name the task,
                        e.g. "Auth refactor" (ignored if the session exists)
      --agent <name>    agent name for new sessions (default: $SIDESHOW_AGENT or "agent")
      --new-session     force a fresh session
  sideshow upload <file> [options]        upload an asset, print its id and URL
      --kind <k>        image|trace|file (default: inferred from the file type)
      --session <id>    session to attach to (default: auto)
  sideshow asset-url <file>               print the URL a file will have (content hash; no upload)
  sideshow image <file> [options]         upload an image and publish it as a post
      --title <t>       post title
      --caption <c>     caption shown under the image
      (also: --session, --session-title, --agent, --new-session)
  sideshow trace <file> [options]         upload a trace file and publish it as a post
      --title <t>       post title
      (also: --session, --session-title, --agent, --new-session)
  sideshow diff <file|-> [options]        publish a diff post from a patch
      --title <t>       post title
      --layout <mode>   "unified" (default) or "split"
      (also: --session, --session-title, --agent, --new-session)
  sideshow markdown <file|-> [options]    publish a markdown post (prose)
      --title <t>       post title
  sideshow terminal <file|-> [options]    publish terminal output (monospace + ANSI)
      --title <t>       post title
      --term-title <t>  label shown in the terminal window chrome
      --cols <n>        render width hint, in columns
      (also: --session, --session-title, --agent, --new-session)
  sideshow mermaid <file|-> [options]     publish a mermaid post (diagram → SVG)
      --title <t>       post title
      (also: --session, --session-title, --agent, --new-session)
  sideshow json <file|-> [options]        publish a JSON post (collapsible tree)
      --title <t>       post title
      (also: --session, --session-title, --agent, --new-session)
  sideshow code <file|-> [options]        publish a code post (shiki-highlighted)
      --title <t>       post (card) title
      --filename <f>    filename shown in the code header bar (defaults to the
                        file argument's basename)
      --language <lang>  shiki language id (ts, js, python, ...); inferred from
                        filename if omitted, "text" if uninferrable
      --line-start <n>  1-based line number the excerpt starts at (shows
                        original line numbers instead of 1-based)
      (also: --session, --session-title, --agent, --new-session)
  sideshow kits                           list the opt-in html kits this workspace offers
  sideshow update <id> <file|->           revise a post (new version, same card)
      --title <t>       replace title
      --kit <id>        opt the html surface into a kit (repeatable)
  sideshow wait [options]                 block until the user comments (long-poll)
      --session <id>    session to watch (default: auto)
      --timeout <sec>   max seconds to wait (default 120)
      --after <seq>     re-read comments after this cursor (default: where the
                        agent left off, tracked server-side across CLI/MCP)
  sideshow watch [options]                stream user comments forever, one per
                                          line (re-arms the long-poll; for a
                                          background monitor)
      --session <id>    session to watch (default: auto, waits for the first
                        publish to create one)
      --after <seq>     re-read comments after this cursor on the first poll
                        (default: resume where the agent left off, server-side)
  sideshow install-hook [options]         register a Claude Code Stop hook so the
                                          trace syncs itself after every turn —
                                          hands-off, no agent effort (Claude Code)
      --shared          write .claude/settings.json (committed) instead of the
                        default .claude/settings.local.json (gitignored, personal)
      --user            write ~/.claude/settings.json (all projects)
      --print           print the hook JSON snippet instead of writing settings
  sideshow trace-sync [options]           manually sync your step trace from the
                                          session transcript onto the timeline —
                                          the fallback when the hook isn't set up
                                          (run after publishing)
      --session <id>    target session (default: auto)
      --transcript <f>  transcript file (default: newest Claude Code log for cwd)
      --pad <n>         prompts of context to keep around the session's posts
                        (default 5; the trace is windowed so it explains how
                        THESE visuals were made, not the whole session)
      --all             sync the whole transcript, not just the windowed slice
      --reset           replace the session's trace (full re-sync, not just the tail)
      --quiet           print nothing on success
  sideshow comment <text> [options]       reply to the user on a post
      --post <id>       post to attach the comment to (required;
                        --surface is a deprecated alias)
      --author <name>   defaults to agent name
  sideshow list [--session <id>|--all]    list posts
  sideshow sessions                       list sessions
  sideshow demo                           seed two example sessions to explore the viewer
  sideshow guide                          print the design contract for posts
  sideshow setup                          print the AGENTS.md integration block
  sideshow agent-howto             print current agent how-to
  sideshow mcp                            run the stdio MCP server (for agent configs)

environment:
  SIDESHOW_URL      server base URL (default http://localhost:8228; set to a
                    deployed instance, e.g. https://sideshow.you.workers.dev)
  SIDESHOW_TOKEN    bearer token for a deployed instance
  SIDESHOW_SESSION  fixed session id (overrides auto-detection)
  SIDESHOW_AGENT    agent name used when creating sessions
`;

function fail(msg) {
  console.error(`sideshow: ${msg}`);
  process.exit(1);
}

async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    fail(`server not reachable at ${BASE} — start it with: sideshow serve`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

// Like api(), but throws instead of exiting the process — for callers that must
// stay alive on failure (the Stop hook must never kill the agent's turn).
async function fetchJson(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

// Session state is keyed by (agent process pid, cwd). Many agents spawn a
// fresh shell per command, so the immediate parent is unstable — walk up the
// process tree past shells to the agent process itself. Falls back to
// cwd-only keying where `ps` is unavailable.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"]);

function getParentPosix(pid) {
  const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const m = out.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return { ppid: 0, isShell: false };
  const ppid = Number(m[1]);
  const comm = m[2].trim().split("/").pop() ?? "";
  return { ppid, isShell: SHELLS.has(comm.replace(/^-/, "")) };
}

function agentPidWindows(startPid) {
  // wmic is removed in Windows 11. Walk the process tree in a single
  // PowerShell call to avoid repeated startup overhead (~300ms per spawn).
  // $procId, not $pid: $PID is a PowerShell automatic variable holding the
  // host process's own id, and reassigning it is confusing at best.
  const script = `
    $procId = ${startPid}
    $shells = @('cmd.exe','powershell.exe','pwsh.exe')
    for ($i = 0; $i -lt 10; $i++) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
      if (!$p) { break }
      if ($shells -notcontains $p.Name.ToLower()) { break }
      if ($p.ParentProcessId -le 1) { break }
      $procId = $p.ParentProcessId
    }
    $procId
  `;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return Number(out) || startPid;
}

function agentPid() {
  try {
    if (process.platform === "win32") return agentPidWindows(process.ppid);
    let pid = process.ppid;
    for (let hops = 0; hops < 10; hops++) {
      const { ppid, isShell } = getParentPosix(pid);
      if (!isShell || !ppid || ppid <= 1) return pid;
      pid = ppid;
    }
    return pid;
  } catch {
    return 0;
  }
}

function stateFile() {
  const dir = join(tmpdir(), `sideshow-${userInfo().username}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha1")
    .update(`${agentPid()}:${process.cwd()}`)
    .digest("hex")
    .slice(0, 12);
  return join(dir, `${key}.json`);
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  writeFileSync(stateFile(), JSON.stringify(next));
  return next;
}

function agentName(flags) {
  return flags.agent ?? process.env.SIDESHOW_AGENT ?? readState().agent ?? "agent";
}

async function resolveSession(flags, { create = false } = {}) {
  if (flags.session) return flags.session;
  if (process.env.SIDESHOW_SESSION) return process.env.SIDESHOW_SESSION;
  const state = readState();
  if (state.session && !flags["new-session"]) {
    const ok = await fetch(`${BASE}/api/sessions/${state.session}/surfaces`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return state.session;
  }
  if (!create) return null;
  const session = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: agentName(flags),
      title: flags["session-title"],
      cwd: process.cwd(),
    }),
  });
  writeState({ session: session.id, agent: agentName(flags) });
  return session.id;
}

// A monitor process (e.g. the Claude Code plugin) may not share the local
// state file written by the agent's CLI calls — different spawn tree, so
// `agentPid()` can hash to a different key. Fall back to asking the server for
// the most recently active session whose cwd matches ours. Uses raw fetch (not
// `api()`) so a transient failure returns null instead of exiting the process.
async function resolveSessionByCwd(cwd = process.cwd()) {
  try {
    const res = await fetch(`${BASE}/api/sessions`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!res.ok) return null;
    const sessions = await res.json();
    return (
      sessions
        .filter((s) => s.cwd === cwd)
        .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)))[0]?.id ?? null
    );
  } catch {
    return null;
  }
}

function readContent(arg) {
  if (!arg || arg === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch {
      fail("no input — pass a file path or pipe HTML on stdin");
    }
  }
  try {
    return readFileSync(arg, "utf8");
  } catch {
    fail(`cannot read file: ${arg}`);
  }
}

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

function outSurface(surface) {
  out({ ...surface, url: `${BASE}/s/${surface.id}` });
}

const CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
};

function contentTypeFor(file) {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Map a filename extension to a shiki language id. Only common languages —
// shiki knows many more, but this covers the files an agent is likely to
// `sideshow code`. Unmapped extensions return undefined (shiki "text").
const LANG_BY_EXT = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  json: "json",
  jsonl: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "docker",
  makefile: "make",
  lua: "lua",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  nim: "nim",
  dart: "dart",
  groovy: "groovy",
  gradle: "groovy",
  vue: "vue",
  svelte: "svelte",
  xml: "xml",
  graphql: "graphql",
  gql: "graphql",
};

function inferLang(file) {
  const base = file.split("/").pop() ?? file;
  if (/^Dockerfile/i.test(base)) return "docker";
  if (/^Makefile/i.test(base)) return "make";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext];
}

// Upload raw file bytes to /api/assets. Returns { id, url, contentType, ... }.
async function uploadFile(file, { session, kind } = {}) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail(`cannot read file: ${file}`);
  }
  const params = new URLSearchParams();
  params.set("filename", file.split(/[\\/]/).pop() ?? "upload");
  if (session) params.set("session", session);
  if (kind) params.set("kind", kind);
  let res;
  try {
    res = await fetch(`${BASE}/api/assets?${params}`, {
      method: "POST",
      headers: {
        "content-type": contentTypeFor(file),
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: bytes,
    });
  } catch {
    fail(`server not reachable at ${BASE} — start it with: sideshow serve`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

// Normalize repeated/comma-joined --kit flags into a deduped id list (or
// undefined). The server allowlists the ids; an unknown one is a clean 400.
function normalizeKits(flag) {
  if (!flag) return undefined;
  const ids = (Array.isArray(flag) ? flag : [flag])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

async function publishSurface(parts, flags) {
  const session = await resolveSession(flags, { create: true });
  return api("/api/surfaces", {
    method: "POST",
    body: JSON.stringify({
      parts,
      title: flags.title,
      session,
      sessionTitle: flags["session-title"],
    }),
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One comment → one line (one monitor notification). Newlines are collapsed so
// a multi-line comment stays a single notification.
function watchLine(c) {
  const text = String(c.text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const where = c.postId ? `on “${c.postTitle ?? "a post"}” (post ${c.postId})` : "on the session";
  return `sideshow comment ${where}: “${text}”`;
}

const [cmd, ...rest] = process.argv.slice(2);

// Subcommand flag parsing. parseArgs is strict, so without this --help (or
// any typo) throws a raw stack trace; instead --help/-h prints usage and
// exits 0, and an unknown option fails with a one-line hint.
function parse(config = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      ...config,
      options: { ...config.options, help: { type: "boolean", short: "h" } },
    });
  } catch (err) {
    if (!String(err?.code).startsWith("ERR_PARSE_ARGS")) throw err;
    fail(`${err.message.split(". ")[0]} — run "sideshow help"`);
  }
  if (parsed.values.help) {
    console.log(HELP);
    process.exit(0);
  }
  return parsed;
}

// Development checkouts run TypeScript directly (Node strips types), but Node
// refuses to type-strip files under node_modules — installed packages ship
// compiled JS in dist/ (built on prepack) and must use it.
function entrypoint(...parts) {
  const built = join(ROOT, "dist", ...parts).replace(/\.ts$/, ".js");
  return existsSync(built) ? built : join(ROOT, ...parts);
}

// --- trace sync: derive a session's step trace from the agent's transcript ---
// The agent already writes a full session transcript; rather than instrument
// every tool call live, we read that transcript and post a curated, truncated,
// incremental batch — the agent runs this at its leisure (e.g. after a publish)
// so the user can see how it got there. Claude Code is the transcript format
// supported today (newest *.jsonl under ~/.claude/projects/<encoded-cwd>/).

const TRACE_MAX_DETAIL = 1800;
const TRACE_MAX_LABEL = 140;
const truncStr = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function findTranscript(cwd) {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"));
  if (!existsSync(dir)) return null;
  let newest = null;
  let newestMs = -1;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    const m = statSync(p).mtimeMs;
    if (m > newestMs) {
      newestMs = m;
      newest = p;
    }
  }
  return newest;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join("");
  }
  return "";
}

// Map a tool call to a compact {kind,label} — a few meaningful kinds, not the
// raw tool zoo (mirrors how a tracing tool normalizes events).
function summarizeTool(name, input) {
  const base = (p) => (typeof p === "string" ? p.split("/").pop() : "");
  if (name === "Read") return { kind: "read", label: `Read ${base(input?.file_path)}` };
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) {
    return { kind: "edit", label: `Edit ${base(input?.file_path ?? input?.notebook_path)}` };
  }
  if (name === "Grep")
    return { kind: "grep", label: `Grep ${JSON.stringify(input?.pattern ?? "")}` };
  if (name === "Glob") return { kind: "glob", label: `Glob ${input?.pattern ?? ""}` };
  if (name === "Bash") return { kind: "run", label: input?.command ?? "command" };
  if (name === "WebFetch") return { kind: "web", label: `Fetch ${input?.url ?? ""}` };
  if (name === "WebSearch")
    return { kind: "web", label: `Search ${JSON.stringify(input?.query ?? "")}` };
  if (name === "Task") return { kind: "agent", label: input?.description ?? "Subagent task" };
  if (name?.startsWith("mcp__")) return { kind: "mcp", label: name.split("__").slice(1).join(" ") };
  return { kind: (name || "tool").toLowerCase().slice(0, 20), label: name || "tool" };
}

// Parse a Claude Code transcript into ordered steps, pairing each tool_use with
// its later tool_result for the detail body. Skips noise (TodoWrite, partial
// last line). Best-effort: a format it doesn't recognize yields no steps.
function buildTraceSteps(text) {
  const steps = [];
  const pending = new Map(); // tool_use_id -> step index awaiting its result
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
    const role = rec.message?.role;
    const content = rec.message?.content;

    // A genuine user prompt: real text the user typed, not an injected/meta
    // message (isMeta), a slash-command wrapper or system-reminder (starts with
    // "<"), or a user record that only carries a tool_result. Those latter ones
    // fall through to the block loop so their results still pair with the call.
    if (role === "user" && !rec.isMeta && !rec.isSidechain) {
      const carriesResult =
        Array.isArray(content) && content.some((b) => b?.type === "tool_result");
      let prompt = "";
      if (typeof content === "string") prompt = content;
      else if (Array.isArray(content) && !carriesResult) {
        prompt = content
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      prompt = prompt.trim();
      if (prompt && !prompt.startsWith("<")) {
        steps.push({
          kind: "prompt",
          label: truncStr(prompt.split("\n")[0], TRACE_MAX_LABEL),
          detail: truncStr(prompt, TRACE_MAX_DETAIL),
          ts,
        });
        continue;
      }
    }

    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && role === "assistant") {
        const say = (block.text ?? "").trim();
        if (say) {
          steps.push({
            kind: "say",
            label: truncStr(say.split("\n")[0], TRACE_MAX_LABEL),
            detail: truncStr(say, TRACE_MAX_DETAIL),
            ts,
          });
        }
      } else if (block?.type === "tool_use" && block.name !== "TodoWrite") {
        const { kind, label } = summarizeTool(block.name, block.input);
        steps.push({
          kind,
          label: truncStr(label, TRACE_MAX_LABEL),
          detail: truncStr(JSON.stringify(block.input ?? {}), TRACE_MAX_DETAIL),
          ts,
        });
        pending.set(block.id, steps.length - 1);
      } else if (block?.type === "tool_result") {
        const idx = pending.get(block.tool_use_id);
        if (idx != null) {
          const out = truncStr(resultText(block.content), 1200).trim();
          if (out)
            steps[idx].detail = truncStr(`${steps[idx].detail}\n\n→ ${out}`, TRACE_MAX_DETAIL);
          pending.delete(block.tool_use_id);
        }
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        const think = block.thinking.trim();
        if (think)
          steps.push({ kind: "think", label: truncStr(think.split("\n")[0], TRACE_MAX_LABEL), ts });
      }
    }
  }
  return steps;
}

// Restrict a transcript's steps to a window of prompts around this session's
// posts, so each session's trace shows how ITS visuals were made — the
// prompts/thinking/tools near when they were published — not the whole
// transcript. `pad` is how many prompts of context to keep on each side.
function scopeToSurfaces(steps, surfaceTimes, pad) {
  if (!surfaceTimes.length) return steps;
  const promptTs = steps
    .filter((s) => s.kind === "prompt" && s.ts)
    .map((s) => Date.parse(s.ts))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!promptTs.length) return steps;
  const first = surfaceTimes[0];
  const last = surfaceTimes[surfaceTimes.length - 1];
  const countAtOrBefore = (t) => promptTs.filter((p) => p <= t).length;
  const startIdx = Math.max(0, countAtOrBefore(first) - 1 - pad);
  const endIdx = Math.min(promptTs.length - 1, Math.max(0, countAtOrBefore(last) - 1) + pad);
  const startTs = promptTs[startIdx];
  const endTs = endIdx + 1 < promptTs.length ? promptTs[endIdx + 1] : Infinity;
  return steps.filter((s) => {
    const t = s.ts ? Date.parse(s.ts) : NaN;
    return Number.isFinite(t) && t >= startTs && t < endTs;
  });
}

// Core trace sync, shared by the `trace-sync` command and the `hook`. Reads the
// transcript, windows it around the session's posts (unless `all`), and POSTs
// the slice. Uses fetchJson (throws, never exits) so the hook can swallow
// failures. A windowed sync always replaces — the span shifts as the session
// grows, so the per-session cursor only matters for un-windowed (`all`) syncs.
async function syncTrace({ session, transcript, pad = 5, all = false, reset = false }) {
  const steps = buildTraceSteps(readFileSync(transcript, "utf8"));
  let scoped = steps;
  if (!all) {
    const metas = await fetchJson(`/api/sessions/${session}/surfaces`).catch(() => []);
    const times = (Array.isArray(metas) ? metas : [])
      .map((m) => Date.parse(m.createdAt))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    scoped = scopeToSurfaces(steps, times, pad);
  }
  const windowed = scoped.length !== steps.length;
  const cursors = readState().traceCursors ?? {};
  const prev = cursors[session];
  const doReset = reset || windowed || prev == null || scoped.length < prev;
  const toSend = doReset ? scoped : scoped.slice(prev);
  if (toSend.length === 0 && !doReset) {
    return { session, added: 0, reset: false, windowed, total: scoped.length };
  }
  const res = await fetchJson(`/api/sessions/${session}/trace`, {
    method: "POST",
    body: JSON.stringify({ steps: toSend, reset: doReset }),
  });
  writeState({ traceCursors: { ...cursors, [session]: scoped.length } });
  return { session, added: toSend.length, reset: doReset, windowed, total: res.count };
}

// Read all of stdin (the JSON payload a Claude Code hook delivers). Resolves to
// "" when there's no piped input (e.g. a TTY) so callers can no-op cleanly.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const commands = {
  async serve() {
    const { values: flags } = parse({
      options: { port: { type: "string" }, open: { type: "boolean" } },
    });
    const port = flags.port ?? process.env.PORT ?? "8228";
    const child = spawn(process.execPath, [entrypoint("server", "index.ts")], {
      stdio: "inherit",
      env: { ...process.env, PORT: port },
    });
    if (flags.open) {
      const url = `http://localhost:${port}`;
      const { opener, openerArgs } =
        process.platform === "darwin"
          ? { opener: "open", openerArgs: [url] }
          : process.platform === "win32"
            ? { opener: "cmd", openerArgs: ["/c", "start", url] }
            : { opener: "xdg-open", openerArgs: [url] };
      setTimeout(() => spawn(opener, openerArgs, { stdio: "ignore" }), 700);
    }
    child.on("exit", (code) => process.exit(code ?? 0));
  },

  async mcp() {
    parse();
    const child = spawn(process.execPath, [entrypoint("mcp", "server.ts")], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  },

  async publish() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        md: { type: "string" },
        mermaid: { type: "string" },
        diff: { type: "string" },
        image: { type: "string" },
        terminal: { type: "string" },
        json: { type: "string" },
        code: { type: "string" },
        kit: { type: "string", multiple: true },
        layout: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const htmlPart = { kind: "html", html: readContent(positionals[0]) };
    const kits = normalizeKits(flags.kit);
    if (kits) htmlPart.kits = kits;
    const parts = [htmlPart];
    if (flags.md !== undefined) {
      parts.push({ kind: "markdown", markdown: readContent(flags.md || "-") });
    }
    if (flags.mermaid !== undefined) {
      parts.push({ kind: "mermaid", mermaid: readContent(flags.mermaid || "-") });
    }
    if (flags.diff !== undefined) {
      parts.push({
        kind: "diff",
        patch: readContent(flags.diff || "-"),
        ...(flags.layout === "split" && { layout: "split" }),
      });
    }
    if (flags.terminal !== undefined) {
      parts.push({ kind: "terminal", text: readContent(flags.terminal || "-") });
    }
    if (flags.json !== undefined) {
      const text = readContent(flags.json || "-");
      try {
        parts.push({ kind: "json", data: JSON.parse(text) });
      } catch {
        fail(`--json: invalid JSON${flags.json ? ` in ${flags.json}` : ""}`);
      }
    }
    if (flags.code !== undefined) {
      const codeFile = flags.code || "-";
      const part = { kind: "code", code: readContent(codeFile) };
      const codeLang = codeFile !== "-" ? inferLang(codeFile) : undefined;
      if (codeLang) part.language = codeLang;
      if (codeFile !== "-") part.title = codeFile.split("/").pop() || codeFile;
      parts.push(part);
    }
    // Resolve the session first so the image upload and the post share it.
    const session = await resolveSession(flags, { create: true });
    if (flags.image !== undefined) {
      const asset = await uploadFile(flags.image, { session, kind: "image" });
      parts.push({ kind: "image", assetId: asset.id });
    }
    outSurface(await publishSurface(parts, { ...flags, session }));
  },

  async upload() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: { session: { type: "string" }, kind: { type: "string" } },
    });
    const file = positionals[0];
    if (!file || file === "-") fail("usage: sideshow upload <file> [--kind k] [--session id]");
    const session = flags.session ?? (await resolveSession(flags, { create: true }));
    const asset = await uploadFile(file, { session, kind: flags.kind });
    out(asset);
  },

  // Print the URL a file WILL have once uploaded, derived from its content hash
  // alone — no server call. Lets you write an <img src> (or reference the id)
  // before, or in parallel with, the upload. Matches the server's hashAssetId.
  async "asset-url"() {
    const { positionals } = parse({ allowPositionals: true, options: {} });
    const file = positionals[0];
    if (!file || file === "-") fail("usage: sideshow asset-url <file>");
    const id = createHash("sha256").update(readFileSync(file)).digest("hex");
    out({ id, url: `${BASE}/a/${id}` });
  },

  async image() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        caption: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const file = positionals[0];
    if (!file || file === "-") fail("usage: sideshow image <file> [--title t]");
    const session = await resolveSession(flags, { create: true });
    const asset = await uploadFile(file, { session, kind: "image" });
    const part = {
      kind: "image",
      assetId: asset.id,
      ...(flags.caption && { caption: flags.caption }),
    };
    outSurface(await publishSurface([part], { ...flags, session }));
  },

  async trace() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const file = positionals[0];
    if (!file || file === "-") fail("usage: sideshow trace <file> [--title t]");
    const session = await resolveSession(flags, { create: true });
    const asset = await uploadFile(file, { session, kind: "trace" });
    outSurface(
      await publishSurface([{ kind: "trace", assetId: asset.id }], {
        ...flags,
        session,
      }),
    );
  },

  async diff() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        layout: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const parts = [
      {
        kind: "diff",
        patch: readContent(positionals[0]),
        ...(flags.layout === "split" && { layout: "split" }),
      },
    ];
    outSurface(await publishSurface(parts, flags));
  },

  async markdown() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const parts = [{ kind: "markdown", markdown: readContent(positionals[0]) }];
    const surface = await publishSurface(parts, flags);
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
  },

  async terminal() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        "term-title": { type: "string" },
        cols: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const cols = Number(flags.cols);
    const parts = [
      {
        kind: "terminal",
        text: readContent(positionals[0]),
        ...(Number.isFinite(cols) && cols > 0 && { cols: Math.floor(cols) }),
        ...(flags["term-title"] && { title: flags["term-title"] }),
      },
    ];
    const surface = await publishSurface(parts, flags);
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
  },

  async mermaid() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const parts = [{ kind: "mermaid", mermaid: readContent(positionals[0]) }];
    outSurface(await publishSurface(parts, flags));
  },

  async json() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    if (!positionals[0]) fail("usage: sideshow json <file|-> [--title t]");
    const text = readContent(positionals[0]);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      fail(`invalid JSON${positionals[0] !== "-" ? ` in ${positionals[0]}` : ""}`);
    }
    const parts = [{ kind: "json", data }];
    outSurface(await publishSurface(parts, flags));
  },
  async code() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        filename: { type: "string" },
        language: { type: "string" },
        "line-start": { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    if (!positionals[0])
      fail(
        "usage: sideshow code <file|-> [--title t] [--filename f] [--language lang] [--line-start n]",
      );
    const code = readContent(positionals[0]);
    const lang = flags.language ?? (positionals[0] !== "-" ? inferLang(positionals[0]) : undefined);
    const part = { kind: "code", code };
    if (lang) part.language = lang;
    const ls = Number(flags["line-start"]);
    if (Number.isFinite(ls) && ls >= 1) part.lineStart = Math.floor(ls);
    // The surface's title (filename) shows inside the code surface's header bar.
    // Default to the basename of the file argument; --filename overrides; use
    // --title for the post (card) title instead.
    const filename =
      flags.filename ??
      (positionals[0] !== "-" ? positionals[0].split("/").pop() || positionals[0] : undefined);
    if (filename) part.title = filename;
    outSurface(await publishSurface([part], flags));
  },
  async update() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: { title: { type: "string" }, kit: { type: "string", multiple: true } },
    });
    const id = positionals[0];
    if (!id) fail("usage: sideshow update <id> <file|->");
    const part = { kind: "html", html: readContent(positionals[1]) };
    const kits = normalizeKits(flags.kit);
    if (kits) part.kits = kits;
    outSurface(
      await api(`/api/surfaces/${id}`, {
        method: "PUT",
        body: JSON.stringify({ parts: [part], title: flags.title }),
      }),
    );
  },

  async wait() {
    const { values: flags } = parse({
      options: {
        session: { type: "string" },
        timeout: { type: "string" },
        after: { type: "string" },
      },
    });
    const session = await resolveSession(flags);
    if (!session) fail("no active session — publish something first, or pass --session");
    if (flags.after !== undefined && !/^\d+$/.test(flags.after)) {
      fail(`--after must be a number (got "${flags.after}")`);
    }
    const timeout = Math.max(1, Number(flags.timeout ?? 120));
    const deadline = Date.now() + timeout * 1000;
    // No client-side cursor: without --after, the server resumes from the
    // session's agent cursor, shared with piggyback and MCP delivery.
    let cursor = flags.after;
    let result = { comments: [] };
    while (Date.now() < deadline && result.comments.length === 0) {
      const chunk = Math.min(60, Math.ceil((deadline - Date.now()) / 1000));
      const afterParam = cursor === undefined ? "" : `&after=${cursor}`;
      result = await api(`/api/comments?session=${session}&author=user${afterParam}&wait=${chunk}`);
      cursor = result.lastSeq;
    }
    out(
      result.comments.length > 0
        ? { comments: result.comments }
        : {
            comments: [],
            timedOut: true,
            hint: "no user feedback yet — run wait again or continue",
          },
    );
  },

  async watch() {
    const { values: flags } = parse({
      options: {
        session: { type: "string" },
        after: { type: "string" },
      },
    });
    if (flags.after !== undefined && !/^\d+$/.test(flags.after)) {
      fail(`--after must be a number (got "${flags.after}")`);
    }
    // A continuous long-poll that streams each new user comment as one line —
    // one line is one Claude Code monitor notification. It re-arms forever and
    // never exits on its own; a transient network error backs off and retries
    // rather than failing (unlike `api()`, which would exit the process).
    //
    // After the first poll it carries no client cursor: reading with
    // author=user resumes from the session's server-side agent cursor and
    // advances it, so a comment is delivered exactly once across watch, wait,
    // and piggyback. Honoring a local cursor here would re-deliver anything a
    // piggybacked write had already consumed.
    let firstAfter = flags.after;
    for (;;) {
      const session = (await resolveSession(flags)) ?? (await resolveSessionByCwd());
      if (!session) {
        // No session yet — the agent hasn't published. Wait and retry.
        await sleep(2000);
        continue;
      }
      let result;
      try {
        const afterParam = firstAfter === undefined ? "" : `&after=${firstAfter}`;
        const res = await fetch(
          `${BASE}/api/comments?session=${session}&author=user${afterParam}&wait=60`,
          { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} },
        );
        if (!res.ok) {
          await sleep(2000);
          continue;
        }
        result = await res.json();
      } catch {
        await sleep(2000);
        continue;
      }
      firstAfter = undefined;
      for (const c of result.comments ?? []) {
        console.log(watchLine(c));
      }
    }
  },

  // Derive this session's step trace from the agent's transcript and post the
  // steps appended since last run (one batched call). The agent runs it at a
  // checkpoint — e.g. right after publishing — so the timeline shows the work
  // behind each post. Idempotent: a per-session cursor sends only the tail,
  // and the first sync of a session replaces (reset) so re-runs never dupe.
  async "trace-sync"() {
    const { values: flags, positionals } = parse({
      options: {
        session: { type: "string" },
        transcript: { type: "string" },
        pad: { type: "string" },
        all: { type: "boolean" },
        quiet: { type: "boolean" },
        reset: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const session = (await resolveSession(flags)) ?? (await resolveSessionByCwd());
    if (!session) fail("no active session — publish first, or pass --session");
    const transcript = flags.transcript ?? positionals[0] ?? findTranscript(process.cwd());
    if (!transcript || !existsSync(transcript)) {
      fail(
        `no transcript found (looked under ~/.claude/projects for ${process.cwd()}) — pass --transcript <file>`,
      );
    }
    const pad = flags.pad != null ? Math.max(0, parseInt(flags.pad, 10) || 0) : 5;
    let result;
    try {
      result = await syncTrace({
        session,
        transcript,
        pad,
        all: flags.all,
        reset: flags.reset,
      });
    } catch (err) {
      fail(err.message);
    }
    if (!flags.quiet) out(result);
  },

  // Internal: run from a Claude Code Stop hook. Reads the hook payload on stdin
  // (transcript_path, cwd) and syncs the trace for whichever sideshow session
  // owns that cwd. Claude Code hands us the exact transcript, so this never has
  // to guess. Must NEVER disturb the agent — every failure path is swallowed and
  // the process exits 0 with no stdout (a Stop hook's stdout is parsed as JSON).
  async hook() {
    try {
      const raw = await readStdin();
      const payload = raw ? JSON.parse(raw) : {};
      const transcript = payload.transcript_path;
      const cwd = payload.cwd || process.cwd();
      if (!transcript || !existsSync(transcript)) return;
      const session = process.env.SIDESHOW_SESSION ?? (await resolveSessionByCwd(cwd));
      if (!session) return; // no sideshow session for this cwd — nothing to trace
      await syncTrace({ session, transcript });
    } catch {
      // A trace hook must never interfere with the agent — stay silent.
    }
  },

  // Register the Stop hook in Claude Code settings so the trace syncs itself
  // after every turn. Writes .claude/settings.local.json by default (gitignored,
  // personal); --shared targets the committed .claude/settings.json; --user the
  // global ~/.claude/settings.json. Idempotent. --print just emits the snippet.
  async "install-hook"() {
    const { values: flags } = parse({
      options: {
        print: { type: "boolean" },
        shared: { type: "boolean" },
        user: { type: "boolean" },
        event: { type: "string" },
      },
    });
    const event = flags.event ?? "Stop";
    const command = `${SELF} hook`;
    const entry = { hooks: [{ type: "command", command }] };
    if (flags.print) {
      out({ hooks: { [event]: [entry] } });
      return;
    }
    const file = flags.user
      ? join(homedir(), ".claude", "settings.json")
      : flags.shared
        ? join(process.cwd(), ".claude", "settings.json")
        : join(process.cwd(), ".claude", "settings.local.json");
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // missing or unparseable — start fresh
    }
    settings.hooks ??= {};
    settings.hooks[event] ??= [];
    // Match our specific `sideshow[.js] hook` invocation — NOT the feedback
    // hook (`sideshow-stop-hook.mjs check|watch`), which also contains both
    // "sideshow" and "hook" but ends in a different verb.
    const isOurs = (cmd) => typeof cmd === "string" && /sideshow(\.js)?["']?\s+hook\b/.test(cmd);
    const already = settings.hooks[event].some((g) =>
      (g.hooks ?? []).some((h) => isOurs(h.command)),
    );
    if (already) {
      out({ ok: true, file, event, status: "already-installed" });
      return;
    }
    settings.hooks[event].push(entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    out({ ok: true, file, event, command, status: "installed" });
  },

  async comment() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        post: { type: "string" },
        surface: { type: "string" }, // deprecated alias
        snippet: { type: "string" }, // legacy alias
        author: { type: "string" },
        agent: { type: "string" },
      },
    });
    const text = positionals.join(" ").trim();
    if (!text) fail("usage: sideshow comment <text> --post <id>");
    // --surface / --snippet stay as back-compat aliases for --post; the request
    // body key is the wire field `surface`, kept as-is.
    const post = flags.post ?? flags.surface ?? flags.snippet;
    if (!post) fail("a comment must target a post — pass --post <id>");
    out(
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          text,
          surface: post,
          author: flags.author ?? agentName(flags),
        }),
      }),
    );
  },

  async list() {
    const { values: flags } = parse({
      options: { session: { type: "string" }, all: { type: "boolean" } },
    });
    if (flags.all) {
      const sessions = await api("/api/sessions");
      const result = [];
      for (const s of sessions) {
        result.push({ ...s, surfaces: await api(`/api/sessions/${s.id}/surfaces`) });
      }
      return out(result);
    }
    const session = flags.session ?? (await resolveSession(flags));
    if (!session) fail("no active session — pass --session or --all");
    out(await api(`/api/sessions/${session}/surfaces`));
  },

  async sessions() {
    parse();
    out(await api("/api/sessions"));
  },

  // List the opt-in html kits this workspace offers (id, label, summary, classes).
  // Pair with `publish --kit <id>` to inject a kit's CSS/JS into an html surface.
  async kits() {
    parse();
    out(await api("/api/kits"));
  },

  async demo() {
    parse();
    const { DEMO_SESSIONS } = await import("./demoData.js");
    for (const demo of DEMO_SESSIONS) {
      const session = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ agent: demo.agent, title: demo.title }),
      });
      for (const snip of demo.snippets) {
        const snippet = await api("/api/snippets", {
          method: "POST",
          body: JSON.stringify({ session: session.id, title: snip.title, html: snip.html }),
        });
        for (const step of snip.followups ?? []) {
          if (step.update) {
            await api(`/api/snippets/${snippet.id}`, {
              method: "PUT",
              body: JSON.stringify(step.update),
            });
          }
          if (step.comment) {
            await api("/api/comments", {
              method: "POST",
              body: JSON.stringify({ snippet: snippet.id, ...step.comment }),
            });
          }
        }
      }
    }
    console.log(`Seeded ${DEMO_SESSIONS.length} demo sessions — open ${BASE} to look around.`);
  },

  async guide() {
    parse();
    console.log(await fetchTextWithFallback("/guide", join(ROOT, "guide", "DESIGN_GUIDE.md")));
  },

  async setup() {
    parse();
    console.log(await fetchTextWithFallback("/setup", join(ROOT, "guide", "AGENT_SETUP.md")));
  },

  async "agent-howto"() {
    parse();
    console.log(await fetchTextWithFallback("/agent-howto", join(ROOT, "guide", "AGENT_HOWTO.md")));
  },
};

async function fetchTextWithFallback(path, localFile) {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (res.ok) return await res.text();
  } catch {}
  return readFileSync(localFile, "utf8");
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
} else if (commands[cmd]) {
  await commands[cmd]();
} else {
  fail(`unknown command "${cmd}" — run "sideshow help"`);
}
