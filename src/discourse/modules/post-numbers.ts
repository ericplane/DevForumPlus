import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { articleOf } from "../topic-data";
import { onDomChange } from "../dom-watch";

/**
 * Post numbers in bylines.
 *
 * Everything on this forum that points at a post does it by number — "see
 * #42", the timeline's "82 / 83", the `/t/slug/id/42` permalink, the
 * accepted-answer line — and nothing on the post itself says which number it
 * is. The stock byline shows a date, and the number is only discoverable by
 * hovering the date and reading the address bar.
 *
 * ── An attribute, not a node ────────────────────────────────────────────────
 * The module stamps `data-dfp-n="<N>"` on the post's own date link and
 * timeline-marks.css renders "#N" from it with `attr()`, before the date, in
 * the same anchor. A second anchor was the obvious shape and is the wrong one:
 * the date link IS the post's permalink, so a "#42" beside it that also linked
 * would be two links to the same place a tab-stop apart, and one that did not
 * link would be a number sitting next to the thing it names without belonging
 * to it. Inside the anchor it is part of the permalink — click "#42", copy
 * post 42's address — with nothing added to the tab order and nothing for
 * Ember to reconcile on re-render: an attribute survives a patch of the text
 * node inside, and a full replacement of the anchor is caught by the sweep.
 *
 * The number is the post NUMBER from `article#post_N`, the one every reference
 * above uses — never `data-post-id`, the database id, which is what the id
 * attribute's neighbour carries and what a reader would never see anywhere.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Read by timeline-marks.css: `a.post-date[data-dfp-n]::before`. */
const ATTR = "data-dfp-n";

/**
 * The post's own date link, and only that one.
 *
 * Embedded replies expanded above or below a post render a byline of their
 * own, `.topic-meta-data.embedded-reply`, but with no `.post-infos` at all
 * (stale-answer.ts, from Discourse's embedded-post widget) — so within an
 * article, `.post-infos a.post-date` can only be the article's own. That is
 * what makes the selector safe, not document order: the `top` section renders
 * before the post's own row.
 */
const DATE_LINK = ".post-infos a.post-date";

function stamp(article: Element): void {
  const n = /^post_(\d+)$/.exec(article.id)?.[1];
  if (!n) return;
  const link = article.querySelector<HTMLElement>(DATE_LINK);
  // Compared, not re-set: the sweep runs on every DOM batch, and an
  // unconditional attribute write dirties style on a page Discourse is
  // already mutating constantly.
  if (!link || link.getAttribute(ATTR) === n) return;
  link.setAttribute(ATTR, n);
}

/**
 * Every date link not yet stamped. One query with the `:not()` inside it, so
 * a settled page — the common case for a batch — costs the query and nothing
 * else, and no article is walked twice.
 */
function sweep(): void {
  const missing = document.querySelectorAll<HTMLElement>(
    `article[id^='post_'] ${DATE_LINK}:not([${ATTR}])`,
  );
  for (const link of missing) {
    const article = link.closest("article[id^='post_']");
    if (article) stamp(article);
  }
}

export function postNumbers(api: PluginApi): DfpModule {
  return {
    id: "post-numbers",
    budgetMs: 40,

    install() {
      /* The decorator stamps a post as its body renders, which is before the
       * first paint of a fresh screen; the sweep below covers what the hook
       * does not see — posts rendered before install landed (decorate.ts), and
       * a byline Discourse replaced wholesale on like or edit. `onlyStream`:
       * the composer preview has no byline to stamp. */
      decorateCooked(
        api,
        (element) => {
          const article = articleOf(element);
          if (article) stamp(article);
        },
        { id: "dfp-post-numbers", onlyStream: true },
      );

      /* `childList` only, and safe from self-triggering: the one write here is
       * an attribute, which the shared observer does not watch. */
      onDomChange(() => sweep());
    },
  };
}
