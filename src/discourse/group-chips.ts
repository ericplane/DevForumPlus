/**
 * Group flair chips, shared by every surface that shows them.
 *
 * Extracted from the profile module once user cards and post bylines needed the
 * same thing. The rendering is identical everywhere; what differs per surface is
 * how many fit before the rest go behind a "+N more".
 *
 * On what each surface actually knows — measured against the live forum:
 *
 *   /u/{name}.json     full group list, each with flair       → profile, card
 *   /u/{name}/card.json  **zero** groups, one flair only      → not usable
 *   post payload       one flair (`flair_name`/`flair_url`)   → post bylines
 *
 * That asymmetry is why post bylines show a single chip rather than a list: the
 * full set would cost one request per author, and a long topic has dozens.
 */

export interface GroupLike {
  id?: number;
  name: string;
  full_name?: string | null;
  flair_url?: string | null;
  flair_bg_color?: string | null;
  flair_color?: string | null;
}

const cache = new Map<string, Promise<GroupLike[]>>();

/** `/u/ericplane/summary` → `ericplane`. */
export function usernameFromPath(pathname: string): string | null {
  const m = /^\/u\/([^/]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Cached per username — a card reopened, or a profile revisited, costs nothing.
 *
 * A failed request is deliberately *not* cached. Collapsing a 429, a 5xx or a
 * dropped connection into an empty array and memoizing it would record "this
 * member has no groups" permanently: every later card open and every profile
 * visit would hand back the cached empty promise and render nothing, silently,
 * with no retry short of a page reload. Eviction would not save it either —
 * the map below is insertion-ordered FIFO, so a poisoned entry survives until
 * 24 further distinct members have been looked up.
 *
 * An genuinely empty list is a real answer and is cached like any other.
 */
export function loadGroups(username: string): Promise<GroupLike[]> {
  let hit = cache.get(username);
  if (!hit) {
    hit = fetch(`/u/${encodeURIComponent(username)}.json`, {
      headers: { Accept: "application/json" },
      // Group membership is only returned to a session allowed to see it.
      credentials: "same-origin",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ user?: { groups?: GroupLike[] } }>;
      })
      .then((d) => d?.user?.groups ?? [])
      .catch(() => {
        cache.delete(username);
        return [];
      });
    cache.set(username, hit);
    if (cache.size > 24) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}

/** An uploaded image, or an id in Discourse's SVG sprite? */
function isImageFlair(flair: string): boolean {
  return flair.startsWith("/") || flair.startsWith("http");
}

/**
 * `0043FF` → `#0043FF`. Discourse's API stores these without the hash.
 *
 * `rgb()`/`rgba()` pass through: post bylines read their colour back out of a
 * rendered element, where it has already been computed, rather than from JSON.
 * Anything else is rejected — this value goes straight into a style property.
 */
export function hex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^rgba?\([\d\s.,%/]+\)$/i.test(v)) return v;
  const bare = v.replace(/^#/, "");
  return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(bare) ? `#${bare}` : null;
}

/** Group names are machine-ish (`UI_Designers`); underscores read as spaces. */
export function groupLabel(name: string): string {
  return name.replace(/_/g, " ");
}

export function chip(group: GroupLike): HTMLElement {
  const a = document.createElement("a");
  a.className = "dfp-group-chip";
  a.href = `/g/${encodeURIComponent(group.name)}`;
  a.title = group.full_name || groupLabel(group.name);

  const flair = group.flair_url?.trim();
  if (flair) {
    const badge = document.createElement("span");
    badge.className = "dfp-group-chip__icon";
    const bg = hex(group.flair_bg_color);
    const fg = hex(group.flair_color);
    if (bg) badge.style.setProperty("--chip-bg", bg);
    if (fg) badge.style.setProperty("--chip-fg", fg);

    if (isImageFlair(flair)) {
      const img = document.createElement("img");
      // Protocol-relative URLs are what Discourse stores.
      img.src = flair.startsWith("//") ? `https:${flair}` : flair;
      img.alt = "";
      img.loading = "lazy";
      badge.appendChild(img);
    } else {
      /* Reference Discourse's own sprite rather than shipping icons. Every id
       * used on this forum was confirmed present in the page's <symbol> set. */
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("dfp-group-chip__svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", `#${flair}`);
      svg.appendChild(use);
      badge.appendChild(svg);
    }
    a.appendChild(badge);
  }

  const label = document.createElement("span");
  label.className = "dfp-group-chip__name";
  label.textContent = groupLabel(group.name);
  a.appendChild(label);

  return a;
}

/**
 * A strip of chips, with everything past `limit` behind a toggle.
 *
 * The overflow chips are rendered and then hidden rather than withheld, so
 * expanding costs no request and no layout work beyond the reveal. (They are
 * hidden with `display: none`, which does take them out of find-in-page — an
 * earlier version of this comment claimed otherwise. Making them findable would
 * mean `hidden="until-found"`, which is not worth the complexity here.)
 *
 * Some members of this forum are in more than twenty groups; without a cap the
 * strip becomes the tallest thing on the card.
 */
export function chipStrip(groups: GroupLike[], limit: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "dfp-group-chips";

  const overflow = groups.length - limit;
  // One over the limit costs the same room as showing it, so don't hide it.
  const cut = overflow > 1 ? limit : groups.length;

  groups.forEach((g, i) => {
    const c = chip(g);
    if (i >= cut) c.classList.add("dfp-group-chip--extra");
    wrap.appendChild(c);
  });

  const hidden = groups.length - cut;
  if (hidden > 0) {
    wrap.dataset.expanded = "0";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "dfp-group-chip dfp-group-chip--more";
    more.setAttribute("aria-expanded", "false");
    // Casing matches Discourse's own badge overflow ("+10 More"), which on a
    // user card sits directly under this one.
    const shut = `+${hidden} More`;
    more.textContent = shut;

    more.addEventListener("click", (e) => {
      // Inside a user card the click would otherwise close the popover.
      e.preventDefault();
      e.stopPropagation();
      const open = wrap.dataset.expanded === "1";
      wrap.dataset.expanded = open ? "0" : "1";
      more.setAttribute("aria-expanded", open ? "false" : "true");
      more.textContent = open ? shut : "Show Less";
    });

    wrap.appendChild(more);
  }

  return wrap;
}
