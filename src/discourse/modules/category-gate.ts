import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";

/**
 * Say whether you can post here, before you write the post.
 *
 * PLAN.md §7.2 #10: Bug Reports and Feature Requests are group-gated. People
 * write a long, careful report and discover the gate at submit time.
 *
 * The plan's hook was `/g/{name}.json` plus the current user's groups, which
 * would have meant knowing which group guards which category — a mapping the
 * API does not publish and that would have to be hardcoded and would rot.
 * Verified today, there is a direct answer instead: an authenticated
 * `/site.json` returns `permission` on every category, computed for *you*.
 *
 *   permission === 1   you can create topics here
 *   permission null/2/3 you cannot
 *
 * Checked against reality on a real account: every child of Feature Requests
 * came back 1 (the account holds `AllowFeatureRequests`), and every child of
 * Bug Reports came back null (it does not hold `bug-files`). That is the gate,
 * per user, with no group mapping to maintain.
 *
 * `has_children` is the other half. Container categories — Updates, Help and
 * Feedback, Bug Reports itself — are also non-postable, because nobody posts in
 * a container. Warning on those would put a gate notice on 9 categories that
 * are not gated at all, so only leaves are considered: 27 real gates rather
 * than 36 mixed ones.
 *
 * The banner does not invent an enrolment path. Where access comes from is
 * documented in each category's own "About" topic, which Discourse hands us as
 * `topic_url`, so it links there rather than guessing at a process that may
 * have changed.
 */

const MARK = "data-dfp-gate";

interface SiteCategory {
  id: number;
  name?: string;
  permission?: number | null;
  has_children?: boolean;
  topic_url?: string | null;
  description_text?: string | null;
}

let sitePromise: Promise<Map<number, SiteCategory> | null> | null = null;

function loadCategories(): Promise<Map<number, SiteCategory> | null> {
  sitePromise ??= fetch("/site.json", {
    headers: { Accept: "application/json" },
    // `permission` is per-user, so this is worthless without the session.
    credentials: "same-origin",
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ categories?: SiteCategory[] }>) : null))
    .then((s) => {
      if (!s?.categories) return null;
      return new Map(s.categories.map((c) => [c.id, c]));
    })
    .catch(() => null);
  return sitePromise;
}

/** `/c/updates/announcements/36` → 36. The id is always the last segment. */
export function categoryIdFromPath(pathname: string): number | null {
  const m = /^\/c\/(?:[^/]+\/)*(\d+)(?:\/|$)/.exec(pathname);
  return m ? Number(m[1]) : null;
}

export function isGated(category: SiteCategory): boolean {
  return category.permission !== 1 && !category.has_children;
}

function build(category: SiteCategory): HTMLElement {
  const box = document.createElement("aside");
  box.className = "dfp-gate";
  box.setAttribute(MARK, "1");

  const text = document.createElement("p");
  text.className = "dfp-gate__text";
  /* Deliberately says "start a topic" rather than "post here". Verified on
   * Engine Bugs: Discourse's own `#create-topic` is disabled, but Roblox adds
   * its own enabled "Report Bug" button beside it, which is a different route
   * into the same category. Claiming a dead end next to a working button would
   * be worse than saying nothing. */
  text.textContent =
    `You can read ${category.name ?? "this category"} but cannot start a topic here — ` +
    `it is restricted by group membership.`;
  box.appendChild(text);

  // Discourse gives every category an "About" topic; that is where this forum
  // documents how to get in. Linking it beats hardcoding a process.
  if (category.topic_url) {
    const link = document.createElement("a");
    link.className = "dfp-gate__link";
    link.href = category.topic_url;
    link.textContent = "How access works";
    box.appendChild(link);
  }

  return box;
}

function apply(): void {
  const id = categoryIdFromPath(location.pathname);
  /* Cleanup first. Leaving a gated category for a topic or the homepage used to
   * return early here, stranding the banner on a page it says nothing about. */
  if (id === null) {
    document.querySelector(`[${MARK}]`)?.remove();
    return;
  }

  void loadCategories().then((cats) => {
    // The route may have changed while site.json was in flight.
    if (categoryIdFromPath(location.pathname) !== id) return;

    const existing = document.querySelector(`[${MARK}]`);
    const category = cats?.get(id);
    if (!category || !isGated(category)) {
      existing?.remove();
      return;
    }
    if (existing) return;

    // Above the list, below the category navigation — the last thing read
    // before deciding to write.
    const anchor =
      document.querySelector(".navigation-container") ??
      document.querySelector(".topic-list")?.closest(".contents") ??
      null;
    if (!anchor) return;
    anchor.after(build(category));
  });
}

export function categoryGate(api: PluginApi): DfpModule {
  return {
    id: "category-gate",
    budgetMs: 4,

    install() {
      api.onPageChange(() => apply());
      // onPageChange does not fire for the load that brought us here.
      apply();
    },
  };
}
