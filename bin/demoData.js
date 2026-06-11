// Seed content for `sideshow demo` — two example sessions that show what
// agents draw on the surface. Keep this file dependency-free like the CLI.

const JWT_DIAGRAM = `
<svg width="100%" viewBox="0 0 680 320">
  <line class="leader" x1="110" y1="52" x2="110" y2="300"/>
  <line class="leader" x1="340" y1="52" x2="340" y2="300"/>
  <line class="leader" x1="570" y1="52" x2="570" y2="300"/>

  <rect class="box" x="35" y="10" width="150" height="40"/>
  <text class="th" x="110" y="35" text-anchor="middle">Client</text>
  <g class="c-blue"><rect class="box" x="265" y="10" width="150" height="40"/><text class="th" x="340" y="35" text-anchor="middle">/api (guarded)</text></g>
  <g class="c-amber"><rect class="box" x="495" y="10" width="150" height="40"/><text class="th" x="570" y="35" text-anchor="middle">/auth/refresh</text></g>

  <text class="ts" x="225" y="84" text-anchor="middle">request + expired JWT</text>
  <line class="arr" x1="110" y1="92" x2="334" y2="92" marker-end="url(#arrow)"/>

  <text class="ts c-red" x="225" y="120" text-anchor="middle">401 token_expired</text>
  <line class="arr c-red" x1="340" y1="128" x2="116" y2="128" marker-end="url(#arrow)"/>

  <text class="ts" x="340" y="172" text-anchor="middle">refresh token (httpOnly cookie)</text>
  <line class="arr" x1="110" y1="180" x2="564" y2="180" marker-end="url(#arrow)"/>

  <text class="ts c-green" x="340" y="208" text-anchor="middle">new JWT + rotated refresh token</text>
  <line class="arr c-green" x1="570" y1="216" x2="116" y2="216" marker-end="url(#arrow)"/>

  <text class="ts" x="225" y="260" text-anchor="middle">retry with new JWT</text>
  <line class="arr" x1="110" y1="268" x2="334" y2="268" marker-end="url(#arrow)"/>
</svg>`;

const JWT_EXPLAINER = `
<p style="font-family: var(--font-sans); color: var(--color-text-primary); line-height: 1.6; margin: 14px 6px 4px;">
  The access token lives in memory only (a JS variable) — never localStorage, so XSS
  can't exfiltrate a long-lived credential. The client never stores the refresh token
  in JS — it lives in an httpOnly cookie and only travels to
  <code style="font-family: var(--font-mono); font-size: 0.92em;">/auth/refresh</code>.
  Rotation means a stolen refresh token dies on first reuse.
</p>`;

const BACKOFF = `
<div id="bk" style="font-family: var(--font-sans); color: var(--color-text-primary);">
  <div style="display: flex; align-items: center; gap: 12px;">
    <span style="font-weight: 500;">Base delay</span>
    <input type="range" id="base" min="50" max="1000" step="50" value="200" style="flex: 1;">
    <span id="baseVal" style="width: 64px; text-align: right; font-weight: 500;">200 ms</span>
  </div>
  <label style="display: flex; align-items: center; gap: 8px; margin: 10px 0 14px; color: var(--color-text-secondary); cursor: pointer;">
    <input type="checkbox" id="jitter">
    Full jitter — each client waits a random time within the window
  </label>
  <div id="rows"></div>
</div>
<script>
  var baseEl = document.getElementById("base");
  var jitterEl = document.getElementById("jitter");
  var ATTEMPTS = 5;

  function fmt(ms) {
    return ms < 1000 ? Math.round(ms) + " ms" : (Math.round(ms / 100) / 10) + " s";
  }

  function render() {
    var base = Number(baseEl.value);
    document.getElementById("baseVal").textContent = fmt(base);
    var max = base * Math.pow(2, ATTEMPTS - 1);
    var html = "";
    for (var i = 0; i < ATTEMPTS; i++) {
      var delay = base * Math.pow(2, i);
      var actual = jitterEl.checked ? Math.random() * delay : delay;
      html +=
        '<div style="display: flex; align-items: center; gap: 10px; margin: 7px 0;">' +
        '<span style="width: 72px; color: var(--color-text-secondary); font-size: 13px;">attempt ' + (i + 1) + "</span>" +
        '<span style="flex: 1; height: 10px; border-radius: 5px; background: var(--color-background-secondary); position: relative; overflow: hidden;">' +
        '<span style="position: absolute; inset: 0; width: ' + (delay / max) * 100 + '%; background: var(--color-background-info);"></span>' +
        '<span style="position: absolute; inset: 0; width: ' + (actual / max) * 100 + '%; background: var(--color-text-info); border-radius: 5px;"></span>' +
        "</span>" +
        '<span style="width: 64px; text-align: right; font-size: 13px;">' + fmt(actual) + "</span>" +
        "</div>";
    }
    document.getElementById("rows").innerHTML = html;
  }

  baseEl.oninput = render;
  jitterEl.onchange = render;
  render();
</script>`;

const QUEUE_METRICS = `
<div style="font-family: var(--font-sans); color: var(--color-text-primary);">
  <div style="display: flex; gap: 10px; margin-bottom: 16px;">
    <div style="flex: 1; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 12px 14px;">
      <div style="font-size: 22px; font-weight: 500;">12 ms</div>
      <div style="font-size: 12px; color: var(--color-text-secondary);">p50 wait</div>
    </div>
    <div style="flex: 1; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 12px 14px;">
      <div style="font-size: 22px; font-weight: 500;">86 ms</div>
      <div style="font-size: 12px; color: var(--color-text-secondary);">p95 wait</div>
    </div>
    <div style="flex: 1; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 12px 14px;">
      <div style="font-size: 22px; font-weight: 500; color: var(--color-text-success);">−71%</div>
      <div style="font-size: 12px; color: var(--color-text-secondary);">p95 vs yesterday</div>
    </div>
    <div style="flex: 1; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 12px 14px;">
      <div style="font-size: 22px; font-weight: 500;">1.4k</div>
      <div style="font-size: 12px; color: var(--color-text-secondary);">jobs / min</div>
    </div>
  </div>
  <svg width="100%" viewBox="0 0 680 150" font-family="var(--font-sans)" font-size="11">
    <g id="bars"></g>
    <line x1="430" y1="8" x2="430" y2="120" stroke="var(--color-border-secondary)" stroke-dasharray="3 4"/>
    <text x="436" y="16" fill="var(--color-text-tertiary)">batched dequeue deployed</text>
    <text x="20" y="140" fill="var(--color-text-tertiary)">p95 queue wait, last 24h</text>
  </svg>
</div>
<script>
  var p95 = [
    270, 290, 310, 285, 300, 320, 295, 305, 330, 310, 290, 315,
    300, 295, 310, 88, 84, 90, 82, 86, 84, 88, 85, 86
  ];
  var W = 660 / p95.length;
  var g = document.getElementById("bars");
  var ns = "http://www.w3.org/2000/svg";
  for (var i = 0; i < p95.length; i++) {
    var h = (p95[i] / 340) * 112;
    var r = document.createElementNS(ns, "rect");
    r.setAttribute("x", 20 + i * W + 2);
    r.setAttribute("y", 120 - h);
    r.setAttribute("width", W - 4);
    r.setAttribute("height", h);
    r.setAttribute("rx", 2);
    r.setAttribute("fill", p95[i] < 150 ? "var(--color-text-success)" : "var(--color-text-info)");
    g.appendChild(r);
  }
</script>`;

// Seeded in order; the viewer sorts sessions by last activity, so the last
// session here ends up on top.
export const DEMO_SESSIONS = [
  {
    agent: "pi",
    title: "Queue profiling",
    snippets: [
      {
        title: "Queue latency after batched dequeue",
        html: QUEUE_METRICS,
      },
    ],
  },
  {
    agent: "claude-code",
    title: "Auth refactor",
    snippets: [
      {
        title: "JWT refresh flow",
        html: JWT_DIAGRAM,
        followups: [
          { comment: { author: "user", text: "Where does the access token live client-side?" } },
          { update: { html: JWT_DIAGRAM + JWT_EXPLAINER } },
          {
            comment: {
              author: "claude-code",
              text: "In memory only — never localStorage. Updated the diagram to show it.",
            },
          },
        ],
      },
      {
        title: "Exponential backoff, intuitively",
        html: BACKOFF,
      },
    ],
  },
];
