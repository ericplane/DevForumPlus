import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import {
  DOC_BARE_GLOBALS,
  DOC_CLASSES,
  DOC_DATATYPES,
  DOC_ENUMS,
  DOC_NAMESPACES,
} from "../../luau/docs-names.generated";

/**
 * Creator Docs links in prose, given the card that code already gets.
 *
 * `create.roblox.com/docs/reference/engine/classes/Humanoid#Health` is the most
 * common link on this forum after a topic link, and today it is a bare blue URL:
 * you cannot tell a class from a datatype from an enum, or a property from a
 * method, without opening it.
 *
 * ── Why this module is thirty lines ─────────────────────────────────────────
 * The card already exists. code-intel marks API names inside code blocks with
 * `data-dfp-api="Owner"` or `"Owner.Member"`, and docs-card.ts in the isolated
 * world renders the hover from packaged docs shards. So this does not build a
 * fourth hover card — it translates a URL back into the same vocabulary and
 * lets the existing one answer.
 *
 * That is also why it costs no request: the whole docs index is already in the
 * bundle. `docsUrl()` in code-intel.ts builds these URLs from an api string;
 * this is that function run backwards, and the two must keep agreeing.
 *
 * One interaction worth knowing: docs-card's confirm pass only touches
 * `a[data-dfp-api]:not([href])` — the inert member-level anchors code-intel
 * ships. Every anchor here already has the author's href, so it is never
 * rewritten, only read.
 *
 * ── Why unknown names are left alone ────────────────────────────────────────
 * Every name is checked against the packaged sets before the attribute goes on.
 * A docs URL can point at a page this bundle has never heard of — a new class, a
 * guide rather than a reference page, a typo — and the honest answer there is an
 * ordinary link. Marking it would promise a card that then renders empty, which
 * is the one failure mode this codebase refuses everywhere else.
 * ───────────────────────────────────────────────────────────────────────────
 */

const SCANNED = "data-dfp-docs-scan";
const API = "data-dfp-api";

/**
 * A docs page that is NOT an API reference — a guide, a tutorial, an art doc.
 *
 * These carry a path rather than an api string, because there is nothing in the
 * packaged index to look them up in: the shards contain classes, datatypes,
 * libraries, enums and globals, and `/docs/art/characters/head-comparison` is
 * none of those. The isolated world reads the page's own title and description
 * through the service worker instead. See docs-card.ts.
 */
const PAGE = "data-dfp-docs";

/** Any docs page at all, reference or not. Keep in step with background.ts. */
const ANY_DOCS = /^\/(?:[a-z]{2}-[a-z]{2}\/)?docs\/[\w/-]{1,200}$/;

/**
 * `/docs/reference/engine/<section>/<Name>`, with an optional locale in front.
 *
 * Roblox serves the same page at `/docs/…` and `/en-us/docs/…`, and links in the
 * wild carry either.
 */
const DOCS_PATH =
  /^\/(?:[a-z]{2}-[a-z]{2}\/)?docs\/reference\/engine\/(classes|datatypes|libraries|enums|globals)\/([A-Za-z_][\w]*)\/?$/;

/** The member, when the URL names one. `#Health`, `#new`, `#GetService`. */
const MEMBER = /^#([A-Za-z_][\w]*)$/;

/**
 * URL → the api string docs-card speaks, or null.
 *
 * The section decides which packaged set proves the name, and `globals` is the
 * odd one: the page is a bucket (`LuaGlobals`, `RobloxGlobals`) rather than a
 * thing, so the page name is discarded and the fragment carries the meaning —
 * exactly the inverse of what `docsUrl()` does when it builds these.
 */
function apiFromUrl(pathname: string, hash: string): string | null {
  const m = DOCS_PATH.exec(pathname);
  if (!m) return null;
  const [, section, name] = m as unknown as [string, string, string];
  const member = MEMBER.exec(hash)?.[1] ?? null;

  if (section === "globals") {
    // A bucket page on its own describes nothing hoverable.
    if (!member || !DOC_BARE_GLOBALS.has(member)) return null;
    return `globals.${member}`;
  }

  const known =
    section === "classes"
      ? DOC_CLASSES.has(name)
      : section === "datatypes"
        ? DOC_DATATYPES.has(name)
        : section === "libraries"
          ? DOC_NAMESPACES.has(name)
          : DOC_ENUMS.has(name);
  if (!known) return null;

  /* Enum ITEMS are not marked. `enums/KeyCode#Space` names a value, and the
   * card answers about types and members — it would open on `KeyCode.Space`
   * and have nothing to say. The enum itself is worth a card; its items are
   * not. */
  if (section === "enums") return name;

  return member ? `${name}.${member}` : name;
}

function mark(root: HTMLElement): number {
  let found = 0;
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.hasAttribute(API)) continue;
    /* `pre` because code-intel owns everything inside a code block and rebuilds
     * it from text; `aside.onebox` because Discourse has already drawn a full
     * preview of the same page. */
    if (a.closest("pre, aside.onebox")) continue;
    if (a.hostname !== "create.roblox.com") continue;

    const api = apiFromUrl(a.pathname, a.hash);
    if (api) {
      a.setAttribute(API, api);
      found++;
      continue;
    }
    /* Not a reference page the bundle knows. If it is still a docs page, hand
     * it over as a path — the isolated world can ask the service worker what it
     * is. Anything else (a marketing page, a dashboard link) is left alone. */
    if (ANY_DOCS.test(a.pathname)) {
      a.setAttribute(PAGE, a.pathname);
      found++;
    }
  }
  return found;
}

function enhance(root: HTMLElement): void {
  if (root.hasAttribute(SCANNED)) return;
  root.setAttribute(SCANNED, "1");
  mark(root);
}

export function docsLinks(api: PluginApi): DfpModule {
  return {
    id: "docs-links",
    budgetMs: 40,

    install() {
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-docs-links",
        onlyStream: true,
      });
    },
  };
}

/** Exported for the unit test: this is `docsUrl()` run backwards. */
export { apiFromUrl };
