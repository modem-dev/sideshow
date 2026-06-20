import { render } from "solid-js/web";
import App from "./App.tsx";
import { announceHostReady } from "./host.tsx";
import "./styles.css";

render(() => <App />, document.body);

// The host runtime + slot registry are published as host.tsx evaluates (above);
// tell any deferred host bundle they are live so it can register its slots.
announceHostReady();
