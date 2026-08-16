import { render } from "solid-js/web";
import App from "./App.tsx";
import { CARD_CHROME_CSS } from "../../server/cardChrome.ts";
import "./styles.css";

// The card chrome is shared with the export as a JS string (server/cardChrome.ts),
// so Vite can't fold it into styles.css. Prepended, not appended, so the
// viewer-only rules that build on it (.card-head .vslot, .standalone-main .card)
// still win the cascade.
const chrome = document.createElement("style");
chrome.textContent = CARD_CHROME_CSS;
document.head.prepend(chrome);

render(() => <App />, document.body);
