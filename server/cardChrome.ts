// The post-card chrome — container, head row, title, meta — shared by the live
// viewer (injected alongside styles.css by main.tsx and embed.tsx) and the
// session export shell (exportPage.ts), so the exported file keeps looking like
// the real card column instead of drifting behind a hand-copied echo. Same
// sharing pattern as themes.ts: a runtime-agnostic string over the derived
// theme vars. Viewer-only behavior (hover actions, version pickers, skeletons)
// stays in styles.css; export-only layout stays in exportPage.ts.
export const CARD_CHROME_CSS = `
.card {
  background: var(--surface);
  border: 0.5px solid var(--border);
  border-radius: 12px;
  margin-bottom: 22px;
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
}
.card-title {
  font-weight: 500;
  font-size: 14px;
}
.card-meta {
  font-size: 12px;
  color: var(--faint);
}
`;
