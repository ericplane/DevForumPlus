/**
 * The forum's category table, fetched once per visit and shared.
 *
 * `/site.json` is one request that answers two different questions, and it
 * used to be asked twice: category-gate.ts kept a module-private copy for the
 * per-user `permission` field, and the command palette (isolated world) keeps
 * its own for names. A third reader — the topic hover card wanting a name and
 * a colour for `category_id` — was the point at which a second MAIN-world copy
 * would have been the wrong shape, so the loader lives here and both MAIN
 * modules import it. The palette's copy stays: it runs in the other world,
 * where this cache is not reachable without crossing the bridge for a request
 * the page can make on its own.
 *
 * `credentials: "same-origin"` is load-bearing, not a default. `permission` is
 * computed for the session that asks, and an anonymous `/site.json` answers it
 * as null on every category — which category-gate would read as "gated" and
 * banner the whole forum. The hover card's name and colour are the same for
 * everyone, so they cost nothing extra by riding along.
 */

/** Only the fields DFP reads, so a shape change surfaces as a type error. */
export interface SiteCategory {
  id: number;
  name?: string;
  slug?: string;
  /** Six hex digits without the hash — `"0E76A8"` — as Discourse stores it. */
  color?: string;
  text_color?: string;
  parent_category_id?: number | null;
  permission?: number | null;
  has_children?: boolean;
  topic_url?: string | null;
  description_text?: string | null;
}

let sitePromise: Promise<Map<number, SiteCategory> | null> | null = null;

/**
 * id → category, or null when the forum did not answer.
 *
 * A non-OK response is the server's answer and is kept for the visit: a 403 or
 * a 5xx will not turn into a 200 because a card was hovered again, and asking
 * on every hover is exactly the per-hover cost this cache exists to avoid. A
 * thrown fetch — no network, a dropped connection — is no answer at all, so the
 * slot is forgotten and the next ask tries again, for the reason group-chips.ts
 * gives for its own cache: memoising a blip records it for the whole visit.
 *
 * The line between the two is drawn at the fetch, not at the end of the
 * chain. A 200 whose body will not parse is a server answer too, and the
 * outer catch once forgot it along with the blips — category-gate asks on
 * every page change, so a forum that ever answered `/site.json` with a
 * non-JSON 200 would have been re-asked for hundreds of kB on every route
 * change for the visit. The body's own catch keeps it as null.
 */
export function loadCategories(): Promise<Map<number, SiteCategory> | null> {
  sitePromise ??= fetch("/site.json", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  })
    .then((r) =>
      r.ok ? (r.json() as Promise<{ categories?: SiteCategory[] }>).catch(() => null) : null,
    )
    .then((s) => {
      if (!s?.categories) return null;
      return new Map(s.categories.map((c) => [c.id, c]));
    })
    .catch(() => {
      sitePromise = null;
      return null;
    });
  return sitePromise;
}

/**
 * `"0E76A8"` → `"#0e76a8"`, or null for anything that is not six hex digits.
 *
 * The value is read out of a JSON payload and written into an element's style,
 * so it is validated as a closed shape rather than passed through: a category
 * colour that is not a colour is dropped, and the dot keeps its neutral token.
 * Discourse's own badge does the same hash-prefixing (group-chips.ts `hex`
 * does it for flair colours); this one is stricter because it never sees an
 * `rgb()` value from a rendered element.
 */
export function categoryColor(color: unknown): string | null {
  return typeof color === "string" && /^[0-9a-f]{6}$/i.test(color)
    ? `#${color.toLowerCase()}`
    : null;
}
