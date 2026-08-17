import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import {
  apiText,
  canScreenshot,
  postImageLink,
  postLink,
  postMarkdownPath,
  type Post,
  type ViewerPost,
} from "./api.ts";
import { writeClipboard } from "./clipboard.ts";
import { root } from "./host.ts";
import { ImageIcon, LinkIcon, MarkdownIcon, OpenIcon, ShareIcon } from "./icons.tsx";
import { toast } from "./state.ts";

// The card's single "take this elsewhere" control: one labelled button opening a
// menu of copy/open actions. It replaces the three separate footer icons (copy
// link, open in a new tab, open as PNG) — the bar was out of room, and every new
// export is a row here rather than another icon.
//
// The menu is `position: fixed` and positioned from the button's rect, because
// `.card` is `overflow: hidden` — an absolutely-positioned menu inside the
// footer would be clipped by the card. (The fullscreen surface dialog escapes
// the same way.) Fixed coordinates go stale the moment the page scrolls, so a
// scroll or resize closes the menu rather than letting it drift off its anchor.

const MENU_WIDTH = 216;
const MENU_GAP = 6;
const VIEWPORT_PAD = 8;
// Menu height, derived from the row metrics in styles.css (32px rows, a 9px
// separator block, 4px of panel padding either side) — the menu is measured
// before it can be measured, so the flip decision uses this estimate.
const MENU_HEIGHT = (rows: number) => rows * 32 + 9 + 8;

type MenuAction = {
  key: string;
  label: string;
  icon: () => JSX.Element;
  // A link row renders as an anchor so middle-click and cmd-click still work.
  href?: string;
  run?: () => void | Promise<void>;
  disabledReason?: string;
  separatorBefore?: boolean;
};

export function ShareMenu(props: { post: Post | ViewerPost }) {
  let button!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [at, setAt] = createSignal({ left: 0, top: 0 });
  // The markdown is fetched, not held by the viewer. Kick the request off when
  // the menu opens so the text is usually already in hand by the time the row is
  // clicked — and hand the promise (not an awaited string) to the clipboard, so
  // a slow fetch still copies inside the user gesture. See clipboard.ts.
  let markdown: Promise<string> | null = null;

  const link = () => postLink(props.post.id);

  const close = (refocus = true) => {
    setOpen(false);
    markdown = null;
    if (refocus && button.isConnected) button.focus();
  };

  const copy = async (text: string | Promise<string>, ok: string, fail: string) => {
    close();
    toast((await writeClipboard(text)) ? ok : fail);
  };

  const actions = (): MenuAction[] => [
    {
      key: "link",
      label: "Copy link",
      icon: LinkIcon,
      run: () => copy(link(), "Link copied", "Couldn't copy the link"),
    },
    {
      key: "markdown",
      label: "Copy as markdown",
      icon: MarkdownIcon,
      run: () =>
        copy(
          markdown ?? fetchMarkdown(),
          "Copied as markdown",
          "Couldn't copy this post as markdown",
        ),
    },
    {
      key: "open",
      label: "Open in new tab",
      icon: OpenIcon,
      href: link(),
      separatorBefore: true,
    },
    {
      key: "image",
      label: "Open as image",
      icon: ImageIcon,
      ...(canScreenshot()
        ? { href: postImageLink(props.post.id) }
        : {
            disabledReason:
              "Saving the first surface as an image needs Cloudflare Browser Rendering, which this server doesn't have. See the README.",
          }),
    },
  ];

  const fetchMarkdown = () => (markdown ??= apiText(postMarkdownPath(props.post.id)));

  const items = () =>
    Array.from(menu?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []);

  const focusItem = (index: number) => {
    const all = items();
    if (all.length) all[(index + all.length) % all.length].focus();
  };

  const openMenu = (focusFirst: boolean) => {
    const rect = button.getBoundingClientRect();
    const height = MENU_HEIGHT(actions().length);
    const below = rect.bottom + MENU_GAP;
    setAt({
      left: Math.max(
        VIEWPORT_PAD,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_PAD),
      ),
      // Flip above the button when the menu wouldn't fit under it.
      top:
        below + height > window.innerHeight - VIEWPORT_PAD
          ? Math.max(VIEWPORT_PAD, rect.top - MENU_GAP - height)
          : below,
    });
    setOpen(true);
    fetchMarkdown().catch(() => {
      // A failed prefetch is not worth a toast — the row reports it if used.
      markdown = null;
    });
    if (focusFirst) queueMicrotask(() => focusItem(0));
  };

  const toggle = () => (open() ? close() : openMenu(false));

  // A new version means new content, so a markdown copy held from before it
  // would paste the old post.
  createEffect(
    on(
      () => props.post.version,
      () => {
        markdown = null;
      },
    ),
  );

  // Dismissal, bound only while the menu is open — a feed can hold hundreds of
  // cards, and none of them should be listening to scroll when nothing is open.
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || menu?.contains(target) || button.contains(target)) return;
      close(false);
    };
    // A scroll or resize strands the fixed menu away from its button.
    const onScrollOrResize = () => close(false);
    // Escape is bound at the root, not on the menu: opening by mouse leaves
    // focus on the button, so a menu-scoped handler would never see the key.
    const onKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      event.preventDefault();
      close();
    };
    root().addEventListener("pointerdown", onPointerDown, true);
    root().addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    onCleanup(() => {
      root().removeEventListener("pointerdown", onPointerDown, true);
      root().removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    });
  });

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const all = items();
    const index = all.indexOf(root().activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(all.length - 1);
    } else if (e.key === "Tab") {
      // Tabbing out of a menu dismisses it rather than walking the page behind.
      close();
    }
  };

  return (
    <>
      <button
        ref={(el) => (button = el)}
        class="act share"
        classList={{ open: open() }}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        title="Share this post"
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open()) {
            e.preventDefault();
            openMenu(true);
          }
        }}
      >
        <ShareIcon />
        Share
      </button>
      <Show when={open()}>
        <div
          ref={(el) => (menu = el)}
          class="share-menu"
          role="menu"
          aria-label={`Share "${props.post.title}"`}
          style={{ left: `${at().left}px`, top: `${at().top}px` }}
          onKeyDown={onMenuKeyDown}
        >
          <For each={actions()}>
            {(action) => (
              <>
                <Show when={action.separatorBefore}>
                  <div class="share-sep"></div>
                </Show>
                <Show
                  when={action.href}
                  keyed
                  fallback={
                    <button
                      class="share-item"
                      role="menuitem"
                      type="button"
                      disabled={!!action.disabledReason}
                      title={action.disabledReason}
                      onClick={() => action.run?.()}
                    >
                      {action.icon()}
                      {action.label}
                    </button>
                  }
                >
                  {(href) => (
                    <a
                      class="share-item"
                      role="menuitem"
                      href={href}
                      target="_blank"
                      rel="noopener"
                      onClick={() => close(false)}
                    >
                      {action.icon()}
                      {action.label}
                    </a>
                  )}
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
