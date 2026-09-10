import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { GLOBAL_TYPES } from "../../luau/detect";
import {
  DOC_BARE_GLOBALS,
  DOC_CLASSES,
  DOC_DATATYPES,
  DOC_ENUMS,
  DOC_NAMESPACES,
} from "../../luau/docs-names.generated";

/**
 * Creator Docs cards in prose, given the card that code already gets.
 *
 * `create.roblox.com/docs/reference/engine/classes/Humanoid#Health` is the most
 * common link on this forum after a topic link, and today it is a bare blue URL:
 * you cannot tell a class from a datatype from an enum, or a property from a
 * method, without opening it. And the name written inline — `DataStoreService`,
 * `Humanoid:TakeDamage()`, `task.wait()` in a sentence — is how most replies
 * actually refer to an API, more often than by URL and more often than in a
 * fenced block.
 *
 * ── Why this module is short ────────────────────────────────────────────────
 * The card already exists. code-intel marks API names inside code blocks with
 * `data-dfp-api="Owner"` or `"Owner.Member"`, and docs-card.ts in the isolated
 * world renders the hover from packaged docs shards. So this does not build a
 * fourth hover card — it translates a URL, or an inline `<code>`, back into the
 * same vocabulary and lets the existing one answer.
 *
 * That is also why it costs no request: the whole docs index is already in the
 * bundle. `docsUrl()` in code-intel.ts builds these URLs from an api string;
 * `apiFromUrl` is that function run backwards, and the two must keep agreeing.
 *
 * One interaction worth knowing: docs-card's confirm pass only touches
 * `a[data-dfp-api]:not([href])` — the inert member-level anchors code-intel
 * ships. Every anchor here already has the author's href, and an inline
 * `<code>` is not an anchor, so neither is ever rewritten, only read; a member
 * the shard does not carry falls back to the owner's card in docs-card's own
 * `resolve()`.
 *
 * ── Why unknown names are left alone ────────────────────────────────────────
 * Every name is checked against the packaged sets before the attribute goes on.
 * A docs URL can point at a page this bundle has never heard of — a new class, a
 * guide rather than a reference page, a typo — and the honest answer there is an
 * ordinary link. Marking it would promise a card that then renders empty, which
 * is the one failure mode this codebase refuses everywhere else.
 *
 * ── Why inline code gets a card and nothing else ────────────────────────────
 * No deprecation mark, no stale banner, no rewritten text. In prose a
 * backticked `wait()` is usually a *mention* — "don't use `wait()`" — which is
 * the crying-wolf case detect.ts exists to avoid, and a banner on a reply that
 * is correcting the old API would be the extension arguing with the one person
 * who is right. The card is different: it describes the API, and a description
 * of `wait` is correct whether the sentence recommends it or warns against it.
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

/**
 * The one shape an inline `<code>` may take to earn a card:
 *
 *     Name            Owner.Member        Owner:Member()      Enum.KeyCode.Space
 *     name()          Owner.Member()      Owner:Member
 *
 * One or two names, one separator, an optional empty call. Anything with
 * arguments, whitespace, an assignment or a third hop is a *statement*, and a
 * statement is not a reference — `game:GetService("Players")` names Players
 * only to someone who reads Luau, and the card would open on GetService.
 * `Enum.X.Y` is the single three-part form, handled below.
 */
const INLINE_REF = /^([A-Za-z_]\w*)(?:([.:])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?)?(\(\))?$/;

/**
 * Four or more digits is an asset id, or something shaped like one, and
 * asset-preview.ts walks the same inline code. `Vector3` and `UDim2` carry a
 * digit each and pass; `rbxassetid://1234567` and `Part1234` do not.
 */
const ID_LIKE = /\d{4}/;

/**
 * Inline `<code>` text → the api string docs-card speaks, or null.
 *
 * Exact membership only, never a heuristic: a name is a class because
 * DOC_CLASSES says so, not because it is capitalised. Bare globals need the
 * call parens — `print()` is unmistakable, a backticked `error` or `type` on
 * its own is more often the English word. `game`, `workspace` and `script`
 * resolve through GLOBAL_TYPES to the class they are, exactly as code-intel's
 * `apiRefAt` does, so `game.Players` lands on the Players page and
 * `script.Parent` on `Script.Parent`.
 */
export function apiFromInlineCode(text: string): string | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 80 || ID_LIKE.test(t)) return null;
  const m = INLINE_REF.exec(t);
  if (!m) return null;
  const head = m[1]!;
  const sep = m[2];
  const member = m[3];
  const sub = m[4];
  const call = m[5];

  const isOwner = (n: string) =>
    DOC_CLASSES.has(n) || DOC_DATATYPES.has(n) || DOC_NAMESPACES.has(n) || DOC_ENUMS.has(n);

  if (!member) {
    if (call) return DOC_BARE_GLOBALS.has(head) ? `globals.${head}` : null;
    return isOwner(head) ? head : null;
  }

  /* `Enum.KeyCode` and `Enum.KeyCode.Space`: the enum is the page, the item is
   * not marked — the same rule `apiFromUrl` applies to `enums/KeyCode#Space`,
   * for the same reason. Any other third hop is a chain, not a reference. */
  if (head === "Enum") return sep === "." && DOC_ENUMS.has(member) ? member : null;
  if (sub) return null;

  const owner = isOwner(head) ? head : GLOBAL_TYPES[head];
  if (!owner || !isOwner(owner)) return null;
  // `game.Players`: services are not DataModel members, but the name IS the
  // service class, and that is the page a reader wants.
  if (owner === "DataModel" && DOC_CLASSES.has(member)) return member;
  return `${owner}.${member}`;
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

  /* Inline code. The attribute goes on the `<code>` itself, which is the
   * element under the pointer; docs-card's delegated `closest()` finds it
   * there. Inside an anchor the author already chose a destination, and inside
   * a `<pre>` code-intel has already answered. */
  for (const code of root.querySelectorAll<HTMLElement>("code")) {
    if (code.hasAttribute(API)) continue;
    if (code.closest("pre, a, aside.onebox")) continue;
    const api = apiFromInlineCode(code.textContent ?? "");
    if (!api) continue;
    code.setAttribute(API, api);
    found++;
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
