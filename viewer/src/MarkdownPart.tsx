import { createMemo } from "solid-js";
import MarkdownIt from "markdown-it";
import type { MarkdownPart as MarkdownPartData } from "./api.ts";

// One shared parser. `html: false` is the load-bearing safety choice: a
// markdown part renders to HTML in the trusted viewer's own origin (unlike an
// html part, which is sandboxed), so raw HTML in the source is escaped rather
// than executed, and markdown-it's default link validation drops dangerous
// schemes (javascript:, etc.). That keeps the rendered output safe to inject.
const md = new MarkdownIt({ html: false, linkify: true });

// Open links in a new tab: the markdown renders inside the viewer document
// itself, so a bare anchor click would navigate the whole board away.
const renderLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return renderLinkOpen(tokens, idx, options, env, self);
};

export function MarkdownPart(props: { part: MarkdownPartData }) {
  const html = createMemo(() => md.render(props.part.markdown ?? ""));
  // eslint-disable-next-line solid/no-innerhtml -- sanitized: html:false above
  return <div class="mdpart" innerHTML={html()}></div>;
}
