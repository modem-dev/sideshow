// Opt-in style/behavior bundles for html parts. An html part may list kit ids
// in its `kits` field; renderHtmlPage concatenates each requested kit's CSS
// (and JS) into the sandboxed document AFTER the base KIT_CSS. A default html
// part (no `kits`) is untouched — the richer vocabulary only ships when asked
// for, so kits never homogenize freeform html. Kits are a library you import
// per part, not a frame every surface is locked into.
//
// Runtime-agnostic (no node imports): imported by surfacePage (server render),
// surfaceParts (id allowlist), and surfaced over HTTP/MCP for discovery. Every
// class resolves against the theme `--color-*` / `--font-*` / radius tokens, so
// kit output re-themes with the board like any other html part.

export interface Kit {
  id: string;
  label: string;
  // One-line summary for discovery (sideshow kits / GET /api/kits).
  summary: string;
  // Compact vocabulary blurb, e.g. "tree · badge · chip · dot · bar".
  classes: string;
  // CSS injected into the sandbox doc when this kit is requested.
  css: string;
  // Optional inline JS (runs at end of body, after the host bridge). Sandboxed.
  js?: string;
}

// Layout + text helpers shared by every kit — injected ONCE whenever any kit is
// requested, so kit-specific css below only declares its distinctive classes.
const CORE_CSS = `
.stack{display:flex;flex-direction:column;gap:8px}.stack.sm{gap:4px}.stack.lg{gap:16px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.row.sm{gap:4px}
.between{display:flex;align-items:center;justify-content:space-between;gap:12px}
.grow{flex:1;min-width:0}
.title{font:500 15px/1.35 var(--font-sans);color:var(--color-text-primary)}
.dim{color:var(--color-text-secondary)}.faint{color:var(--color-text-tertiary)}
.mono{font-family:var(--font-mono)}.num{font-variant-numeric:tabular-nums}
.hr{height:1px;border:0;margin:2px 0;background:var(--color-border-secondary)}
.kbd{font:400 12px/1 var(--font-mono);padding:2px 6px;border:1px solid var(--color-border-secondary);border-bottom-width:2px;border-radius:6px;background:var(--color-background-secondary);color:var(--color-text-secondary)}
`;

// issues: cards, status badges/dots, mono ref chips, rollup bars, and a nesting
// rail (.tree → nest another .tree to indent). Composes an issue/PR/CI tree,
// a status board, or a PR summary from generic primitives.
const ISSUES_CSS = `
.card{background:var(--color-background-primary);border:1px solid var(--color-border-secondary);border-radius:var(--border-radius-lg);padding:14px 16px}
.card.soft{background:var(--color-background-secondary)}
.badge{display:inline-flex;align-items:center;gap:5px;font:500 12px/1.4 var(--font-sans);padding:2px 9px;border-radius:999px;background:var(--color-background-secondary);color:var(--color-text-secondary)}
.badge.ok{background:var(--color-background-success);color:var(--color-text-success)}
.badge.info{background:var(--color-background-info);color:var(--color-text-info)}
.badge.warn{background:var(--color-background-warning);color:var(--color-text-warning)}
.badge.danger{background:var(--color-background-danger);color:var(--color-text-danger)}
.chip{display:inline-flex;align-items:center;gap:4px;font:400 12px/1.4 var(--font-mono);padding:1px 7px;border-radius:var(--border-radius-md);border:1px solid var(--color-border-secondary);color:var(--color-text-secondary)}
.dot{width:8px;height:8px;border-radius:999px;background:var(--color-text-tertiary);flex:none}
.dot.ok{background:var(--color-text-success)}.dot.info{background:var(--color-text-info)}.dot.warn{background:var(--color-text-warning)}.dot.danger{background:var(--color-text-danger)}
.bar{height:6px;border-radius:999px;background:var(--color-background-secondary);overflow:hidden}
.bar>i{display:block;height:100%;border-radius:inherit;background:var(--color-text-success)}
.tree{display:flex;flex-direction:column;gap:7px;margin:0;padding:0;list-style:none}
.tree .tree{margin-top:7px;margin-left:9px;padding-left:14px;border-left:1px solid var(--color-border-secondary)}
`;

// slides: a stepped deck. Author `.deck` with `.slide` children; the JS shows
// one at a time and injects prev/dots/counter/next controls. Arrow keys and
// PageUp/Down navigate (plain keys only — the host owns the meta/alt combos).
const SLIDES_CSS = `
.deck{display:block}
.deck>.slide{display:none}
.deck>.slide.on{display:block;min-height:140px}
.deck>.slide h2{font:500 22px/1.3 var(--font-sans);margin:0 0 14px}
.deck-ctl{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:18px;padding-top:14px;border-top:1px solid var(--color-border-secondary)}
.deck-dots{display:inline-flex;gap:7px}
.deck-dots i{width:7px;height:7px;border-radius:999px;background:var(--color-border-primary);cursor:pointer}
.deck-dots i.on{background:var(--color-text-info)}
.deck-num{font:400 13px/1 var(--font-mono);color:var(--color-text-tertiary);min-width:46px;text-align:center}
`;

const SLIDES_JS = `
(function(){
  var deck=document.querySelector('.deck');if(!deck)return;
  var slides=[].slice.call(deck.querySelectorAll(':scope > .slide'));if(!slides.length)return;
  var i=0;
  var ctl=document.createElement('div');ctl.className='deck-ctl';
  var prev=document.createElement('button');prev.type='button';prev.setAttribute('aria-label','Previous slide');prev.textContent='‹';
  var next=document.createElement('button');next.type='button';next.setAttribute('aria-label','Next slide');next.textContent='›';
  var dots=document.createElement('span');dots.className='deck-dots';
  var num=document.createElement('span');num.className='deck-num';
  slides.forEach(function(_,k){var d=document.createElement('i');d.setAttribute('role','button');d.addEventListener('click',function(){go(k);});dots.appendChild(d);});
  ctl.appendChild(prev);ctl.appendChild(dots);ctl.appendChild(num);ctl.appendChild(next);
  deck.appendChild(ctl);
  function go(n){i=(n+slides.length)%slides.length;
    slides.forEach(function(s,k){s.classList.toggle('on',k===i);});
    [].forEach.call(dots.children,function(d,k){d.classList.toggle('on',k===i);});
    num.textContent=(i+1)+' / '+slides.length;}
  prev.addEventListener('click',function(){go(i-1);});
  next.addEventListener('click',function(){go(i+1);});
  document.addEventListener('keydown',function(e){
    if(e.metaKey||e.altKey||e.ctrlKey)return;
    if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();go(i+1);}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(i-1);}});
  go(0);
})();
`;

export const KITS: Kit[] = [
  {
    id: "issues",
    label: "Issues",
    summary: "issue / PR / CI status — trees, badges, chips, rollup bars",
    classes: "card · tree · badge · chip · dot · bar",
    css: ISSUES_CSS,
  },
  {
    id: "slides",
    label: "Slides",
    summary: "a stepped deck with prev/next controls and a counter",
    classes: "deck · slide (+ injected controls)",
    css: SLIDES_CSS,
    js: SLIDES_JS,
  },
];

const KIT_BY_ID = new Map(KITS.map((k) => [k.id, k]));

export const isKnownKit = (id: unknown): id is string =>
  typeof id === "string" && KIT_BY_ID.has(id);

export const KIT_IDS = KITS.map((k) => k.id);

// Compact descriptor for discovery (no CSS/JS payload).
export const kitSummaries = () =>
  KITS.map((k) => ({ id: k.id, label: k.label, summary: k.summary, classes: k.classes }));

// Resolve a list of kit ids to the CSS/JS to inject. Unknown ids are ignored;
// duplicates collapse; CORE ships once when any known kit is present.
export function kitAssets(ids: readonly string[] | undefined): { css: string; js: string } {
  if (!ids || ids.length === 0) return { css: "", js: "" };
  const seen = new Set<string>();
  const chosen: Kit[] = [];
  for (const id of ids) {
    const kit = KIT_BY_ID.get(id);
    if (kit && !seen.has(id)) {
      seen.add(id);
      chosen.push(kit);
    }
  }
  if (chosen.length === 0) return { css: "", js: "" };
  let css = CORE_CSS;
  let js = "";
  for (const kit of chosen) {
    css += kit.css;
    if (kit.js) js += kit.js;
  }
  return { css, js };
}
