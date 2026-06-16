#!/usr/bin/env node
// sideshow-term CLI — Node built-ins only. Talks to the sideshow-term server
// over HTTP for publishing/listing, and shells out to Bun for the opentui
// pieces (`watch`, `render`) since opentui's native core needs Bun's FFI.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BASE = (process.env.SIDESHOW_URL ?? "http://localhost:4242").replace(/\/$/, "");
const TOKEN = process.env.SIDESHOW_TOKEN;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `sideshow-term — a live terminal visual surface for coding agents

usage:
  sideshow-term serve [--port N]          start the server (REST + SSE + MCP)
  sideshow-term watch                     open the live TUI viewer (needs Bun)
  sideshow-term render <file|-> [--width N]  preview STML to plain text (needs Bun)
  sideshow-term publish <file|-> [opts]   publish an STML snippet
      --title <t>            snippet title
      --session <id>         target session (default: auto per cwd)
      --session-title <t>    name for a newly created session
      --agent <name>         agent name for new sessions
      --new-session          force a fresh session
  sideshow-term update <id> <file|->      revise a snippet (new version)
      --title <t>            replace title
  sideshow-term list [--session <id>|--all]   list snippets
  sideshow-term sessions                  list sessions
  sideshow-term comment <text> [opts]     post a comment
      --snippet <id> | --session <id>
      --author <name>
  sideshow-term demo                      seed an example session
  sideshow-term guide                     print the STML design contract
  sideshow-term setup                     print the agent integration block

environment:
  SIDESHOW_URL    server base URL (default http://localhost:4242)
  SIDESHOW_TOKEN  bearer token for a deployed instance
  SIDESHOW_AGENT  agent name used when creating sessions
`;

function fail(msg) {
  console.error(`sideshow-term: ${msg}`);
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
    fail(`server not reachable at ${BASE} — start it with: sideshow-term serve`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

// Session grouping: remember the last session id per working directory.
function stateFile() {
  const dir = join(tmpdir(), `sideshow-term-${userInfo().username}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12);
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
    const ok = await fetch(`${BASE}/api/sessions/${state.session}/snippets`, {
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
  try {
    return !arg || arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  } catch {
    fail(
      arg && arg !== "-"
        ? `cannot read file: ${arg}`
        : "no input — pass a file path or pipe STML on stdin",
    );
  }
}

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

// Run a Bun script (the opentui pieces). Bun is required only for these.
function runBun(scriptParts, args, { inherit = true } = {}) {
  const child = spawn("bun", [join(ROOT, ...scriptParts), ...args], {
    stdio: inherit ? "inherit" : ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  child.on("error", (err) => {
    if (err.code === "ENOENT")
      fail("this command needs Bun — install it from https://bun.sh, then re-run");
    fail(String(err.message ?? err));
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const rest = process.argv.slice(3);
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
    fail(`${err.message.split(". ")[0]} — run "sideshow-term help"`);
  }
  if (parsed.values.help) {
    console.log(HELP);
    process.exit(0);
  }
  return parsed;
}

const commands = {
  async serve() {
    const { values: flags } = parse({ options: { port: { type: "string" } } });
    const port = flags.port ?? process.env.PORT ?? "4242";
    const child = spawn(process.execPath, [join(ROOT, "server.ts")], {
      stdio: "inherit",
      env: { ...process.env, PORT: port },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  },

  watch() {
    runBun(["src", "watch.ts"], []);
  },

  render() {
    runBun(["src", "previewCli.ts"], rest);
  },

  async publish() {
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
    const html = readContent(positionals[0]);
    const session = await resolveSession(flags, { create: true });
    const snippet = await api("/api/snippets", {
      method: "POST",
      body: JSON.stringify({
        html,
        title: flags.title,
        session,
        sessionTitle: flags["session-title"],
      }),
    });
    out(snippet);
  },

  async update() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: { title: { type: "string" } },
    });
    const id = positionals[0];
    if (!id) fail("usage: sideshow-term update <snippetId> <file|->");
    const html = readContent(positionals[1]);
    out(
      await api(`/api/snippets/${id}`, {
        method: "PUT",
        body: JSON.stringify({ html, title: flags.title }),
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
      for (const s of sessions)
        result.push({ ...s, snippets: await api(`/api/sessions/${s.id}/snippets`) });
      return out(result);
    }
    const session = flags.session ?? (await resolveSession(flags));
    if (!session) fail("no active session — pass --session or --all");
    out(await api(`/api/sessions/${session}/snippets`));
  },

  async sessions() {
    parse();
    out(await api("/api/sessions"));
  },

  async comment() {
    const { values: flags, positionals } = parse({
      allowPositionals: true,
      options: {
        snippet: { type: "string" },
        session: { type: "string" },
        author: { type: "string" },
        agent: { type: "string" },
      },
    });
    const text = positionals.join(" ").trim();
    if (!text) fail("usage: sideshow-term comment <text> [--snippet id]");
    const session = flags.snippet ? undefined : await resolveSession(flags);
    if (!flags.snippet && !session) fail("no active session — pass --snippet or --session");
    out(
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          text,
          snippet: flags.snippet,
          session,
          author: flags.author ?? agentName(flags),
        }),
      }),
    );
  },

  async demo() {
    parse();
    const { DEMO_SESSION } = await import("./demoData.js");
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: DEMO_SESSION.agent, title: DEMO_SESSION.title }),
    });
    for (const snip of DEMO_SESSION.snippets) {
      await api("/api/snippets", {
        method: "POST",
        body: JSON.stringify({ session: session.id, title: snip.title, html: snip.html }),
      });
    }
    console.log(`Seeded a demo session — open the viewer with:  sideshow-term watch`);
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

const cmd = process.argv[2];
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
} else if (commands[cmd]) {
  await commands[cmd]();
} else {
  fail(`unknown command "${cmd}" — run "sideshow-term help"`);
}
