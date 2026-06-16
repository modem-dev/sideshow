#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BASE = (process.env.SIDESHOW_URL ?? "http://localhost:4242").replace(/\/$/, "");
const TOKEN = process.env.SIDESHOW_TOKEN;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `sideshow — a live visual surface for terminal coding agents

usage:
  sideshow serve [--port N] [--open]      start the surface (API + viewer)
  sideshow publish <file|-> [options]     publish an HTML surface (one html part)
      --title <t>       surface title
      --diff <file|->   add a diff part from a unified/git patch (combine with html)
      --image <file>    upload an image and append it as an image part
      --session <id>    target session (default: auto per agent session)
      --session-title <t>  name for a newly created session — name the task,
                        e.g. "Auth refactor" (ignored if the session exists)
      --agent <name>    agent name for new sessions (default: $SIDESHOW_AGENT or "agent")
      --new-session     force a fresh session
  sideshow upload <file> [options]        upload an asset, print its id and URL
      --kind <k>        image|trace|file (default: inferred from the file type)
      --session <id>    session to attach to (default: auto)
  sideshow asset-url <file>               print the URL a file will have (content hash; no upload)
  sideshow image <file> [options]         upload an image and publish it as a surface
      --title <t>       surface title
      --caption <c>     caption shown under the image
      (also: --session, --session-title, --agent, --new-session)
  sideshow trace <file> [options]         upload a trace file and publish it as a surface
      --title <t>       surface title
      (also: --session, --session-title, --agent, --new-session)
  sideshow diff <file|-> [options]        publish a diff surface from a patch
      --title <t>       surface title
      --layout <mode>   "unified" (default) or "split"
      (also: --session, --session-title, --agent, --new-session)
  sideshow update <id> <file|->           revise a surface (new version, same card)
      --title <t>       replace title
  sideshow wait [options]                 block until the user comments (long-poll)
      --session <id>    session to watch (default: auto)
      --timeout <sec>   max seconds to wait (default 120)
      --after <seq>     re-read comments after this cursor (default: where the
                        agent left off, tracked server-side across CLI/MCP)
  sideshow comment <text> [options]       post a reply comment
      --surface <id> | --session <id>     attach point (default: auto session)
      --author <name>   defaults to agent name
  sideshow list [--session <id>|--all]    list surfaces
  sideshow sessions                       list sessions
  sideshow demo                           seed two example sessions to explore the viewer
  sideshow guide                          print the design contract for surfaces
  sideshow setup                          print the AGENTS.md integration block
  sideshow mcp                            run the stdio MCP server (for agent configs)

environment:
  SIDESHOW_URL      server base URL (default http://localhost:4242; set to a
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

const commands = {
  async serve() {
    const { values: flags } = parse({
      options: { port: { type: "string" }, open: { type: "boolean" } },
    });
    const port = flags.port ?? process.env.PORT ?? "4242";
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
        diff: { type: "string" },
        image: { type: "string" },
        layout: { type: "string" },
        session: { type: "string" },
        "session-title": { type: "string" },
        agent: { type: "string" },
        "new-session": { type: "boolean" },
      },
    });
    const parts = [{ kind: "html", html: readContent(positionals[0]) }];
    if (flags.diff !== undefined) {
      parts.push({
        kind: "diff",
        patch: readContent(flags.diff || "-"),
        ...(flags.layout === "split" && { layout: "split" }),
      });
    }
    // Resolve the session first so the image upload and the surface share it.
    const session = await resolveSession(flags, { create: true });
    if (flags.image !== undefined) {
      const asset = await uploadFile(flags.image, { session, kind: "image" });
      parts.push({ kind: "image", assetId: asset.id });
    }
    const surface = await publishSurface(parts, { ...flags, session });
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
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
    const surface = await publishSurface([part], { ...flags, session });
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
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
    const surface = await publishSurface([{ kind: "trace", assetId: asset.id }], {
      ...flags,
      session,
    });
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
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
    const surface = await publishSurface(parts, flags);
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
  },

  async update() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: { title: { type: "string" } },
    });
    const id = positionals[0];
    if (!id) fail("usage: sideshow update <id> <file|->");
    const html = readContent(positionals[1]);
    const surface = await api(`/api/surfaces/${id}`, {
      method: "PUT",
      body: JSON.stringify({ parts: [{ kind: "html", html }], title: flags.title }),
    });
    out({ ...surface, url: `${BASE}/s/${surface.id}` });
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

  async comment() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        surface: { type: "string" },
        snippet: { type: "string" }, // legacy alias
        session: { type: "string" },
        author: { type: "string" },
        agent: { type: "string" },
      },
    });
    const text = positionals.join(" ").trim();
    if (!text) fail("usage: sideshow comment <text> [--surface id]");
    const surface = flags.surface ?? flags.snippet;
    const session = surface ? undefined : await resolveSession(flags);
    if (!surface && !session) fail("no active session — pass --surface or --session");
    out(
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          text,
          surface,
          session,
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
