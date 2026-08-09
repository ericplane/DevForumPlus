# DevForum Plus

A browser extension that makes [devforum.roblox.com](https://devforum.roblox.com) faster, cleaner, and more capable. Chromium only — Chrome, Brave, Edge.

**Status: M0 + M1 complete.** The extension boots into Discourse and fully restyles the forum. Feature work (§7 of [PLAN.md](PLAN.md)) starts at M2.

---

## Quick start

Requires **Node ≥ 20.11** (`import.meta.dirname`; the toolchain fails on 20.9 with a confusing `paths[0]` error). A `.nvmrc` is checked in.

```bash
nvm use && npm install && npm run build
```

Then load it:

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3`
4. Open <https://devforum.roblox.com> and click the DevForum Plus toolbar icon

The popup reports which boot rung engaged — that is the first thing to check if something looks off.

### Scripts

| Command | What it does |
|---|---|
| `npm run build` | Generate tokens → check styles → build to `.output/chrome-mv3` |
| `npm run dev` | WXT dev server with hot reload |
| `npm run check` | Typecheck + style guardrails |
| `npm run tokens` | Regenerate colour tokens; **fails the build** on a contrast regression |
| `npm run harness` | Build `.output/harness.html`, the visual regression page |

---

## How it works

The design is driven by three facts about the live site, all verified rather than assumed. See [PLAN.md §1](PLAN.md#1-ground-truth).

### 1. It integrates with Discourse; it does not scrape

DevForum runs Discourse `3.5.0.beta3-dev` and exposes `withPluginApi` (`PLUGIN_API_VERSION` 2.1.1). DFP registers through it like a theme component — value transformers, Glimmer outlets, `decorateCookedElement` — instead of fighting Ember's renderer with a `MutationObserver`.

### 2. The site's CSP forces a two-world architecture

```
script-src 'nonce-…' 'strict-dynamic'
```

An isolated content script **cannot** append a `<script>` to this page. So DFP ships two content scripts:

- **`main-world.content.ts`** (`world: "MAIN"`) — reaches Discourse's module loader and plugin API. No `chrome.*` access.
- **`isolated.content.ts`** — owns `chrome.*`, stamps `<html>` before first paint, and will own all DFP-rendered UI.

They talk over a `MessageChannel` established by a one-shot handshake. The main world is treated as untrusted by the isolated side; see the threat model in [`protocol.ts`](src/core/bridge/protocol.ts).

There is no `style-src` directive, which is why the entire visual layer survives even if JS integration breaks.

### 3. The boot ladder self-heals

| Rung | How | Result |
|---|---|---|
| **pre-boot** | Trap `window.define`, register an Ember initializer before the app boots | Everything active from the first frame |
| **post-boot** | Poll for `require("discourse/lib/plugin-api")`, call `withPluginApi` | Works from the first navigation; the initial render is unmodified |
| **css-only** | No plugin API reachable | Redesign still works; interactive features off |

A watchdog verifies rung 1 *actually ran* rather than assuming it did, so if Discourse stops scanning its loader for initializers, rung 2 takes over with no code change.

Rung 2 being viable was confirmed empirically against the live forum: post-boot `registerValueTransformer` calls succeed and apply on the next render — they just do not retroactively restyle already-rendered components.

---

## Architecture

```
src/
├─ entrypoints/
│  ├─ main-world.content.ts   # world: MAIN — Discourse integration
│  ├─ isolated.content.ts     # world: ISOLATED — chrome.* + root stamping
│  ├─ background.ts           # service worker
│  └─ popup/                  # Preact: quick toggles + diagnostics
├─ core/
│  ├─ bridge/                 # MessageChannel RPC, hand-rolled validators
│  ├─ registry.ts             # module lifecycle, budgets, auto-disable
│  ├─ settings.ts             # chrome.storage.sync
│  ├─ boot-snapshot.ts        # synchronous first-paint cache
│  └─ root-attrs.ts           # every visual knob is an <html> attribute
├─ discourse/
│  ├─ boot.ts                 # the define trap + fallback ladder
│  ├─ types.ts                # hand-written types for Discourse internals
│  └─ modules/                # one file per feature
└─ styles/
   ├─ tokens.generated.css    # from scripts/build-tokens.ts — do not edit
   ├─ base.css                # retargets Discourse's own CSS variables
   ├─ components/
   └─ overrides/hard.css      # !important quarantine, capped at 20
```

### Design system

Themes are declared as a neutral OKLCH ramp plus seed hues, and every colour is derived from that. Stepping lightness in OKLab gives steps that *look* evenly spaced — the reason hand-built dark palettes usually have one surface level that reads wrong.

`scripts/build-tokens.ts` emits resolved hex (so the contrast numbers asserted at build time are the ones that ship) and **fails the build** if any of its 104 contrast assertions regress.

Five themes — `dark`, `dim`, `black` (OLED), `light`, `off` — × three densities × three corner radii.

**The highest-leverage file is [`base.css`](src/styles/base.css)**, which retargets Discourse's own custom properties (`--primary`, `--secondary`, `--tertiary`, `--d-border-radius`, the numeric ramps) at DFP tokens. One assignment restyles hundreds of rules across 26 plugin stylesheets and six theme components that we never wrote a selector for.

> **Cascade rule:** DFP styles are deliberately **unlayered**. Discourse's CSS is unlayered too, and an `@layer` always loses to unlayered rules regardless of specificity. Putting this design system in a cascade layer is the one change guaranteed to make none of it apply. `npm run check:styles` enforces it.

### Guardrails

- **Contrast gates** — `npm run tokens` fails on regression.
- **Style check** — `!important` quarantined and capped; `@layer` banned.
- **Module budgets** — a module over its install budget three page loads running disables itself and says so in the popup.
- **Nothing throws into Discourse** — every module install is wrapped; a failure disables that feature and nothing else.

---

## Verified vs. unverified

Being explicit, because "it builds" is not "it works":

**Verified**
- Builds clean; typecheck clean; manifest emits both worlds correctly with `world: "MAIN"`
- 104/104 contrast assertions pass
- Content scripts 7.6 kB + 8.5 kB; CSS 28 kB raw / **5.3 kB gzipped** (budget: 40 kB)
- 71 of 110 CSS selectors match live DevForum DOM; the rest are UI states not present anonymously (modals, menus, composer, signed-in chrome)
- Post-boot transformer registration works on the live forum
- Category list, footer and code-block selectors corrected against real DOM

**Not yet verified — needs a hands-on load**
- The **pre-boot rung**. It cannot be tested without loading the extension in a real browser, which this environment could not do. The popup will tell you: "Full" means rung 1 worked, "Recovered" means it fell through to rung 2. Both are functional; the difference is whether the first paint of a topic list carries DFP classes.
- **Signed-in surfaces** — sidebar renders empty for anonymous visitors, so `.sidebar-section-*` selectors are from Discourse core rather than observation. Flagged in [`chrome.css`](src/styles/components/chrome.css).
- Light theme against the real forum (the forum forces its dark scheme for signed-out users).

---

## Notes on scope

No forum action is ever automated — no auto-like, reply, flag, or vote, not behind a flag. Nothing is scraped into an external index. Consent and age-verification scripts are never blocked, even optionally. See [PLAN.md §10](PLAN.md#10-privacy-safety--tos).

`host_permissions` is exactly one origin. No `tabs`, `cookies`, `webRequest`, or `<all_urls>`.
