# DevForum Plus

A browser extension for [devforum.roblox.com](https://devforum.roblox.com) — Luau-aware code
intelligence, faster navigation, and a full restyle. Chromium only: Chrome, Brave, Edge.

Every feature below can be turned off individually, and the redesign can be switched off while
keeping the features.

---

## Features

### Code

**Luau code intelligence.** The forum highlights Luau using highlight.js's *Lua* grammar. Type
annotations, `::` casts, `continue`, generics, compound assignment and string interpolation all
render wrong. DFP re-highlights with a tokenizer written for Luau.

It also marks **deprecated APIs** — the ones that make old answers actively harmful. A 2019 reply
recommending `wait()` and `BodyVelocity` still ranks on Google and still reads as authoritative.
Hovering a mark tells you what to use instead, sourced from Roblox's own API dump.

Hover any class, method, property or enum for its signature, parameters and a link to Creator
Docs. All of it is bundled at build time — no request leaves your browser when you hover.

**Code block controls** add a language label, a soft-wrap toggle, copy-without-comments, and
collapse for long blocks.

### Finding things

**⌘K / Ctrl+K** opens a palette: search topics, jump to any category, and apply Discourse's search
filters as one-click chips instead of remembering `status:solved` and `min_posts:10`.

**Search results** get age marks. Anything two years or older is flagged, because search is the one
place you meet an old answer with no warning at all — on a sample query, 32 of 50 results were 2+
years old. Solved threads get a legible tick; stock renders it in the same grey as the lock icon.

**Hover prefetch** fetches a topic while you hover its link, so opening it is instant, and replays
the real request in the background so your read state still records. A warm cache keeps
recently-read bodies on disk.

### Reading

- Topic lists mark solved, busy, closed and long-dormant threads
- Replies over two years old that recommend replaced APIs carry a quiet caution
- Thread view indents replies by depth, keeping chronological order so permalinks still work
- Gated categories say so before you write the post, not at submit time
- Group chips — every group a member belongs to, with flair — on profiles, user cards and bylines
- Long "liked this" lists fold to twelve faces behind a `+N others` toggle

### Writing

- Similar topics surface as you type a title, so duplicates get caught
- A local draft vault survives a closed tab or a crash
- A Luau code-block button that tags the fence correctly

### Design

Five themes — `dark`, `dim`, `black` (OLED), `light`, `off` — times three densities times three
corner radii. Every colour derives from one OKLCH ramp, and **148 contrast checks run at build
time**; a regression fails the build rather than shipping.

---

## Install

Requires **Node ≥ 20.11** (`import.meta.dirname`; 20.9 fails with a confusing `paths[0]` error).
A `.nvmrc` is checked in.

```bash
nvm use && npm install && npm run build
```

Then load it:

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3`
4. Open <https://devforum.roblox.com>

The toolbar popup reports which boot rung engaged — the first thing to check if something looks off.

| Command           | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `npm run build`   | Tokens → style checks → build to `.output/chrome-mv3`           |
| `npm run dev`     | WXT dev server with hot reload                                  |
| `npm run check`   | Typecheck, style guardrails, unit tests                         |
| `npm run tokens`  | Regenerate colours; **fails the build** on a contrast regression |
| `npm run harness` | Build `.output/harness.html`, the visual regression page         |

---

## How it works

**It integrates with Discourse rather than scraping it.** DevForum runs Discourse
`3.5.0.beta3-dev` and exposes `withPluginApi` (`PLUGIN_API_VERSION` 2.1.1), so DFP registers like a
theme component — value transformers, Glimmer outlets, `decorateCookedElement`.

**The site's CSP (`script-src 'nonce-…' 'strict-dynamic'`) forces two content scripts.** An
isolated script cannot inject one into this page, so `main-world.content.ts` reaches Discourse's
module loader with no `chrome.*` access, and `isolated.content.ts` owns `chrome.*` and stamps
`<html>` before first paint. They talk over a `MessageChannel`; the isolated side treats the main
world as untrusted. There is no `style-src`, which is why the visual layer survives even if the JS
integration breaks.

**Boot self-heals** across three rungs — trapping `window.define` before the app boots, polling for
the plugin API after it, and finally CSS-only. A watchdog verifies rung 1 actually ran rather than
assuming it did.

**Failures are contained.** Every module install is wrapped and budgeted; one that runs over budget
three page loads running disables itself and says so in the popup. Nothing throws into Discourse.

The highest-leverage file is [`base.css`](src/styles/base.css), which retargets Discourse's own
custom properties at DFP tokens — one assignment restyles hundreds of rules across stylesheets we
never wrote a selector for. DFP's CSS is deliberately **unlayered**: Discourse's is too, and an
`@layer` always loses to unlayered rules regardless of specificity. `npm run check:styles` enforces
that, quarantines `!important`, and caps it.

More detail lives in [PLAN.md](PLAN.md) and in the header comment of each module.

---

## Scope

No forum action is ever automated — no auto-like, reply, flag or vote, not behind a flag. Nothing
is scraped into an external index. No analytics, no telemetry. Consent and age-verification scripts
are never blocked, even optionally.

`host_permissions` is exactly one origin. No `tabs`, `cookies`, `webRequest`, or `<all_urls>`.
