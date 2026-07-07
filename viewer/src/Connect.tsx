// Shared self-hosted connect flow. Backported from sideshow-cloud's polished
// connect-an-agent screen, but kept generic for local/self-hosted deployments:
// the URL is the artifact, and the default path is the universal add-mcp installer.
import { createSignal, For, type JSX } from "solid-js";
import { appPath } from "./api.ts";

function defaultMcpUrl(): string {
  return `${location.origin}${appPath("/mcp")}`;
}

function serverUrlFromMcpUrl(url: string): string {
  const u = new URL(url, location.href);
  if (u.pathname.endsWith("/mcp")) u.pathname = u.pathname.slice(0, -"/mcp".length) || "/";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

export function CopyField(props: { value: string }) {
  const [label, setLabel] = createSignal("copy");
  return (
    <div class="copy-field">
      <pre>{props.value}</pre>
      <button
        class="copy"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(props.value);
          setLabel("copied");
          setTimeout(() => setLabel("copy"), 1500);
        }}
      >
        {label()}
      </button>
    </div>
  );
}

// Brand marks for the lane picker. They are monochrome SVGs in currentColor so the
// selected/hover states and all themes stay legible.
type Logo = () => JSX.Element;

const LogoClaude: Logo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

const LogoCursor: Logo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  </svg>
);

const LogoVSCode: Logo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
  </svg>
);

const LogoOpenAI: Logo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

const LogoOpenCode: Logo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
  </svg>
);

const LogoPi: Logo = () => (
  <svg viewBox="0 0 800 800" fill="currentColor" aria-hidden="true">
    <path
      fill-rule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
    />
    <path d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);

const LogoPlug: Logo = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9 7V3M15 7V3M8 7h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4V7ZM12 15v6" />
  </svg>
);

const LogoMostAgents: Logo = () => (
  <span class="connect-logo-row">
    <LogoClaude />
    <LogoOpenAI />
    <LogoCursor />
    <LogoVSCode />
    <LogoOpenCode />
  </span>
);

type Client = {
  name: string;
  logo: Logo;
  setup: (url: string) => JSX.Element;
  approve?: () => JSX.Element;
};

const CLIENTS: Client[] = [
  {
    name: "Most agents",
    logo: LogoMostAgents,
    setup: (url) => <CopyField value={`npx add-mcp ${url}`} />,
    approve: () => <>Reload your agent if it asks, then ask it to publish a sideshow test post.</>,
  },
  {
    name: "Pi",
    logo: LogoPi,
    setup: (url) => {
      const serverUrl = serverUrlFromMcpUrl(url);
      return (
        <>
          <p class="muted">Install the sideshow extension in Pi:</p>
          <CopyField value="pi install npm:sideshow" />
          <p class="muted">Then point it at this server:</p>
          <CopyField value={`export SIDESHOW_URL=${serverUrl}`} />
          <p class="muted">
            If this server uses <code>SIDESHOW_TOKEN</code>, also export it as{" "}
            <code>SIDESHOW_TOKEN</code>.
          </p>
        </>
      );
    },
    approve: () => (
      <>
        <code>/sideshow</code> in Pi confirms the extension can reach this server.
      </>
    ),
  },
  {
    name: "Other",
    logo: LogoPlug,
    setup: (url) => (
      <>
        <p class="muted">Most MCP clients accept a generic HTTP server entry:</p>
        <CopyField value={JSON.stringify({ mcpServers: { sideshow: { url } } }, null, 2)} />
      </>
    ),
  },
];

function Step(props: { n: number; label: string; live?: boolean; children: JSX.Element }) {
  return (
    <li class="connect-step">
      <span class="connect-num" classList={{ live: !!props.live }}>
        {props.n}
      </span>
      <div class="connect-step-body">
        <div class="connect-slabel">{props.label}</div>
        {props.children}
      </div>
    </li>
  );
}

function ClientSteps(props: { url: string; awaiting?: boolean }) {
  const [idx, setIdx] = createSignal(0);
  const tiles: HTMLButtonElement[] = [];
  const client = () => CLIENTS[idx()];
  const move = (to: number) => {
    setIdx(to);
    tiles[to]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = CLIENTS.length;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move((idx() + 1) % n);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move((idx() - 1 + n) % n);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(n - 1);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <p class="connect-pick-label">How do you want to connect?</p>
      <div
        class="connect-logos"
        role="radiogroup"
        aria-label="Choose how to connect"
        onKeyDown={onKeyDown}
      >
        <For each={CLIENTS}>
          {(c, i) => (
            <button
              type="button"
              role="radio"
              class="connect-logo"
              classList={{ on: idx() === i() }}
              aria-checked={idx() === i()}
              tabindex={idx() === i() ? 0 : -1}
              ref={(el) => (tiles[i()] = el)}
              onClick={() => setIdx(i())}
            >
              {c.logo()}
              <span class="connect-logo-name">{c.name}</span>
            </button>
          )}
        </For>
      </div>
      <ol class="connect-flow">
        <Step n={1} label="Add the server">
          {client().setup(props.url)}
        </Step>
        {client().approve && (
          <Step n={2} label="Use it">
            {client().approve?.()}
          </Step>
        )}
        {props.awaiting && (
          <Step n={client().approve ? 3 : 2} label="Watch for the first post" live>
            <div class="connect-wait">
              <span class="connect-pulse" />
              <span>This page updates the moment your agent publishes.</span>
            </div>
          </Step>
        )}
      </ol>
    </>
  );
}

export function ConnectInstructions(props: {
  url?: string;
  variant?: "card" | "plain";
  title?: string;
  subtitle?: string;
  awaiting?: boolean;
}) {
  const url = () => props.url ?? defaultMcpUrl();
  const card = () => props.variant === "card";
  return (
    <div class="connect-block" classList={{ "connect-card": card() }}>
      {card() && (
        <div class="connect-badge" aria-hidden="true">
          <LogoPlug />
        </div>
      )}
      {props.title && <h2 class="connect-hero-title">{props.title}</h2>}
      {props.subtitle && <p class="connect-hero-sub">{props.subtitle}</p>}
      <ClientSteps url={url()} awaiting={props.awaiting} />
      <p class="connect-token-note">
        Protected server? Add <code>Authorization: Bearer &lt;SIDESHOW_TOKEN&gt;</code> in your MCP
        client, or set <code>SIDESHOW_TOKEN</code> for CLI/Pi integrations.
      </p>
    </div>
  );
}
