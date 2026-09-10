/**
 * A one-time card introducing the things you cannot discover by looking.
 *
 * Written because of a real question: with the extension installed and working,
 * the answer to "how do I access thread mode?" was a button at the foot of the
 * timeline rail — at the time, in a topic footer nobody had reason to scroll
 * to, which is why thread-view.ts moved it — and the palette hotkey is
 * invisible by definition. Most of what DFP does announces itself — the theme,
 * the code blocks, the badges — so this deliberately does NOT list features. It
 * lists the three that are silent.
 *
 * The directions have to be right, because this card is the one chance to give
 * them: it said "topic footer" after the move, and on the long threads thread
 * view is for, the footer does not exist until the last post is reached.
 *
 * Shown once, ever, and dismissible. It is stored under its own key rather than
 * in settings so that resetting settings does not resurrect it: nobody wants to
 * be onboarded twice.
 */

import { chord } from "./platform";

const KEY = "dfp:onboarded";
const HOST_ID = "dfp-onboarding";

interface Tip {
  key: string;
  what: string;
}

const TIPS: Tip[] = [
  /* `⌘K` for everyone was a Mac glyph shown to a forum that is mostly on
   * Windows; the handler has always accepted Ctrl. See platform.ts. */
  { key: chord("K"), what: "Search topics and jump to any category" },
  {
    key: "Thread view",
    what: "Button in the timeline rail on the right (beside the progress pill on narrow screens) — indents replies by depth",
  },
  { key: "Hover a Luau name", what: "Signature and docs, offline, in any post" },
];

const CSS = `
:host { all: initial; }
.card {
  position: fixed;
  inset-block-end: 20px;
  inset-inline-end: 20px;
  z-index: 2147483000;
  inline-size: min(22rem, calc(100vw - 32px));
  padding: 16px;
  background: var(--dfp-surface-1, #14171c);
  border: 1px solid var(--dfp-border-strong, #40444a);
  border-radius: var(--dfp-r-lg, 14px);
  box-shadow: 0 18px 44px rgb(0 0 0 / 0.45);
  color: var(--dfp-text, #eff4fc);
  font-family: var(--dfp-font, system-ui, sans-serif);
  /* Multiplied by --dfp-font-scale like the palette's and the docs card's
   * sizes: the Text size control scaled the forum by up to 1.25 while this
   * card stayed at 11-14px. The custom property crosses the host's
   * "all: initial" the way --dfp-surface-* already does; 1 is for an
   * unstamped page. */
  font-size: calc(13px * var(--dfp-font-scale, 1));
  line-height: 1.5;
  animation: in 220ms cubic-bezier(.2,.8,.2,1);
}
@keyframes in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@media (prefers-reduced-motion: reduce) { .card { animation: none } }
h2 { margin: 0 0 2px; font-size: calc(14px * var(--dfp-font-scale, 1)); font-weight: 650; }
p.sub { margin: 0 0 12px; color: var(--dfp-text-3, #868a91); font-size: calc(12px * var(--dfp-font-scale, 1)); }
ul { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 9px; }
li { display: grid; grid-template-columns: auto 1fr; gap: 9px; align-items: baseline; }
kbd {
  font-family: var(--dfp-mono, ui-monospace, monospace);
  font-size: calc(11px * var(--dfp-font-scale, 1)); white-space: nowrap;
  padding: 1px 6px; border-radius: 5px;
  border: 1px solid var(--dfp-border, #333);
  background: var(--dfp-surface-2, #1c1f25);
  color: var(--dfp-accent, #37b3ff);
}
.what { color: var(--dfp-text-2, #b4b8c0); font-size: calc(12px * var(--dfp-font-scale, 1)); }
.row { display: flex; gap: 8px; justify-content: flex-end; }
button {
  all: unset;
  padding: 5px 12px;
  border-radius: 8px;
  font-size: calc(12px * var(--dfp-font-scale, 1));
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--dfp-border, #333);
  color: var(--dfp-text-2, #b4b8c0);
}
button:hover { background: var(--dfp-surface-3, #25282e); color: var(--dfp-text, #eff4fc); }
button.primary {
  background: var(--dfp-accent-soft, #0d2e44);
  border-color: color-mix(in oklab, var(--dfp-accent, #37b3ff) 40%, transparent);
  color: var(--dfp-accent, #37b3ff);
}
button:focus-visible { outline: 2px solid var(--dfp-accent, #37b3ff); outline-offset: 2px; }
`;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function build(dismiss: () => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  const card = el("div", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "DevForum Plus is installed");

  card.append(el("h2", undefined, "DevForum Plus is on"));
  card.append(
    el("p", "sub", "Most of it you can see. These three you cannot:"),
  );

  const list = el("ul");
  for (const tip of TIPS) {
    const li = el("li");
    li.append(el("kbd", undefined, tip.key), el("span", "what", tip.what));
    list.append(li);
  }
  card.append(list);

  const row = el("div", "row");
  const settings = el("button", undefined, "Settings") as HTMLButtonElement;
  settings.type = "button";
  settings.addEventListener("click", () => {
    // `openOptionsPage` is a background-only API; a message keeps this working
    // from a content script without granting anything extra.
    void chrome.runtime.sendMessage({ t: "dfp:open-options" }).catch(() => {});
    dismiss();
  });

  const ok = el("button", "primary", "Got it") as HTMLButtonElement;
  ok.type = "button";
  ok.addEventListener("click", dismiss);

  row.append(settings, ok);
  card.append(row);
  frag.append(card);
  return frag;
}

export function mountOnboarding(): void {
  void chrome.storage.local
    .get(KEY)
    .then((store) => {
      if (store[KEY]) return;
      present();
    })
    .catch(() => {
      // Storage unavailable: showing the card every load would be worse than
      // never showing it.
    });
}

/**
 * The palette's "Show welcome card again" command. Forgets the dismissal first
 * so the card comes back on the next load too if this one is closed by a
 * navigation rather than a button — the point of asking for it is to read it.
 */
export function showOnboarding(): void {
  void chrome.storage.local
    .remove(KEY)
    .catch(() => {})
    .then(present);
}

function present(): void {
  // Only on a real forum page, not on a redirect or an error page.
  if (!document.body) return;
  // Already up: asked for twice, or a second mount racing the first.
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;

  /* Escape dismisses, like every other overlay in the product — unless the
   * palette already took the key to close itself, which it marks by
   * preventing the default; two overlays should not fall to one press. The
   * listener goes with the card, so re-showing it does not stack them. */
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) dismiss();
  };
  const dismiss = () => {
    host.remove();
    removeEventListener("keydown", onKey);
    void chrome.storage.local.set({ [KEY]: Date.now() }).catch(() => {});
  };

  shadow.append(style, build(dismiss));
  document.body.appendChild(host);
  addEventListener("keydown", onKey);
}
