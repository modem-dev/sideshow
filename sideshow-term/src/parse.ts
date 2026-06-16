// STML — Sideshow Terminal Markup Language.
//
// A small, tolerant, HTML-like parser. It has no opentui dependency on
// purpose: it is pure data-in/data-out so it can be unit-tested on plain Node
// (the renderer that turns this AST into opentui Renderables lives in
// render.ts and only runs on Bun). Parsing never throws — malformed input
// degrades to a best-effort tree plus a list of human-readable `errors`, so a
// sloppy snippet still renders something useful.

export interface STMLText {
  type: "text";
  value: string;
}

export interface STMLElement {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: STMLNode[];
}

export type STMLNode = STMLText | STMLElement;

export interface ParseResult {
  nodes: STMLNode[];
  errors: string[];
}

// Tags that never have children — they may be written unclosed (`<br>`) or
// self-closed (`<hr/>`); either way any "</tag>" is tolerated and ignored.
const VOID_TAGS = new Set(["br", "hr", "rule", "divider", "input", "spacer", "space"]);

// Tags whose inner text is taken verbatim — no nested tags, whitespace and
// case preserved. This is what makes <code>, <md> and <ascii> ergonomic.
const RAW_TAGS = new Set(["code", "pre", "ascii", "bigtext", "banner"]);

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// Decode the small entity set STML supports. Numeric (&#65; / &#x41;) included
// so agents can emit box-drawing or arrow glyphs without pasting raw bytes.
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

const isSpace = (ch: string) =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isNameChar = (ch: string) => /[a-zA-Z0-9\-_]/.test(ch);
// A tag name must start with a letter — so "3<4" and "a < b" stay as text.
const isTagStart = (ch: string | undefined) => ch !== undefined && /[a-zA-Z]/.test(ch);

export function parse(input: string): ParseResult {
  const errors: string[] = [];
  const root: STMLNode[] = [];
  const stack: STMLElement[] = [];
  const top = () => (stack.length > 0 ? stack[stack.length - 1].children : root);

  let i = 0;
  const n = input.length;

  const pushText = (value: string) => {
    if (value.length === 0) return;
    const siblings = top();
    const last = siblings[siblings.length - 1];
    // Merge adjacent text so a bare "<" doesn't fragment a run into pieces.
    if (last && last.type === "text") last.value += value;
    else siblings.push({ type: "text", value });
  };

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      pushText(input.slice(i));
      break;
    }
    if (lt > i) pushText(input.slice(i, lt));
    i = lt;

    // Comment
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    // Closing tag
    if (input[i + 1] === "/") {
      let j = i + 2;
      let name = "";
      while (j < n && isNameChar(input[j])) name += input[j++];
      while (j < n && input[j] !== ">") j++;
      i = j + 1;
      name = name.toLowerCase();
      // Pop to the nearest matching open element; tolerate stray/mismatched
      // closers rather than discarding the whole tree.
      const idx = findOpen(stack, name);
      if (idx === -1) {
        errors.push(`stray closing tag </${name}>`);
      } else {
        if (idx !== stack.length - 1) {
          errors.push(`closing </${name}> implicitly closed ${stack.length - 1 - idx} tag(s)`);
        }
        stack.length = idx;
      }
      continue;
    }

    // Not a real tag (a bare "<", or "<" before a digit) — emit as text.
    if (!isTagStart(input[i + 1])) {
      pushText("<");
      i += 1;
      continue;
    }

    // Opening tag
    const open = readOpenTag(input, i);
    if (!open) {
      pushText("<");
      i += 1;
      continue;
    }
    const el: STMLElement = { type: "element", tag: open.tag, attrs: open.attrs, children: [] };
    top().push(el);
    i = open.next;

    if (open.selfClosing || VOID_TAGS.has(open.tag)) continue;

    if (RAW_TAGS.has(open.tag)) {
      const close = `</${open.tag}`;
      const end = indexOfCloser(input, i, close);
      const raw = input.slice(i, end === -1 ? n : end);
      if (raw.length > 0) el.children.push({ type: "text", value: raw });
      if (end === -1) {
        errors.push(`unclosed <${open.tag}>`);
        i = n;
      } else {
        const gt = input.indexOf(">", end);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }

    stack.push(el);
  }

  if (stack.length > 0) {
    errors.push(`unclosed tag(s): ${stack.map((e) => `<${e.tag}>`).join(", ")}`);
  }
  return { nodes: root, errors };
}

function findOpen(stack: STMLElement[], name: string): number {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].tag === name) return k;
  }
  return -1;
}

// Case-insensitive search for a closing tag whose name matches, e.g. "</code".
function indexOfCloser(input: string, from: number, closer: string): number {
  const lower = input.toLowerCase();
  return lower.indexOf(closer.toLowerCase(), from);
}

interface OpenTag {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  next: number;
}

function readOpenTag(input: string, start: number): OpenTag | null {
  const n = input.length;
  let i = start + 1;
  let tag = "";
  while (i < n && isNameChar(input[i])) tag += input[i++];
  if (!tag) return null;
  tag = tag.toLowerCase();
  const attrs: Record<string, string> = {};

  while (i < n) {
    while (i < n && isSpace(input[i])) i++;
    if (i >= n) break;
    if (input[i] === ">") {
      return { tag, attrs, selfClosing: false, next: i + 1 };
    }
    if (input[i] === "/" && input[i + 1] === ">") {
      return { tag, attrs, selfClosing: true, next: i + 2 };
    }
    // attribute name
    let name = "";
    while (i < n && isNameChar(input[i])) name += input[i++];
    if (!name) {
      // unexpected char inside tag — skip it to stay tolerant
      i++;
      continue;
    }
    name = name.toLowerCase();
    while (i < n && isSpace(input[i])) i++;
    if (input[i] === "=") {
      i++;
      while (i < n && isSpace(input[i])) i++;
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        i++;
        let value = "";
        while (i < n && input[i] !== quote) value += input[i++];
        i++; // closing quote
        attrs[name] = decodeEntities(value);
      } else {
        let value = "";
        while (
          i < n &&
          !isSpace(input[i]) &&
          input[i] !== ">" &&
          !(input[i] === "/" && input[i + 1] === ">")
        ) {
          value += input[i++];
        }
        attrs[name] = decodeEntities(value);
      }
    } else {
      // bare boolean attribute
      attrs[name] = "";
    }
  }
  return { tag, attrs, selfClosing: false, next: n };
}
