import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";

/**
 * Excerpts on every topic-list row.
 *
 * The server already sends them. A GET of /latest.json on 2026-09-04 returned
 * 30 topics, 30 with a non-empty `excerpt` and 0 pinned — the site runs with
 * always_include_topic_excerpts on. Discourse renders `.topic-excerpt` only
 * where its `expandPinned` check passes, which is pinned rows, so the two-line
 * clamp topic-list.css has carried for `.topic-excerpt` applied to nothing on
 * an ordinary list, and a reader triaging /latest had the title, the category
 * and the numbers and not one word of the content.
 *
 * ── A transformer, not DOM ──────────────────────────────────────────────────
 * `topic-list-item-expand-pinned` is the value that check reads, and it is
 * registered on this Discourse build (verified live the same day). Answering
 * true makes Discourse's own TopicExcerpt component render on every row — an
 * `<a class="topic-excerpt">` after the category line, so a row reads title /
 * chips / excerpt, with `has-excerpt excerpt-expanded` on the `<tr>` — its
 * escaped excerpt, its "read more" span, re-rendered by Ember on every list
 * update with nothing for DFP to re-apply. Zero requests and zero
 * DFP-built HTML. The alternative — reading `excerpt` off the row payload and
 * inserting it from a DOM watcher — would put HTML from a post body through
 * DFP's hands and a node Ember does not know about under every row it
 * re-renders, and was rejected for both. Same registry and mechanism as
 * `topic-list-item-class` in topic-list-signals.ts.
 *
 * ── Off by default ──────────────────────────────────────────────────────────
 * Two more lines per row is the opposite of what the rest of the list design
 * does — topic-list.css removes 30px of dead space per row, perf.css sizes
 * rows at a measured 79px — so this is a preference, not a fix, and ships off.
 * Settings record exceptions only: a missing `modules` key reads as on
 * (settings-schema.ts, isModuleEnabled), and `normalizeSettings` copies keys
 * from the stored object without consulting DEFAULT_SETTINGS, so an entry
 * there would switch nothing off for anyone whose settings were saved by an
 * earlier build. Off-by-default has to be a property of the id, read by
 * isModuleEnabled when the key is absent — that is the change this module
 * asks of the schema.
 *
 * ── Both refusals reach the registry ────────────────────────────────────────
 * On a `-dev` Discourse the transformer name can vanish, and Discourse's
 * `_registerTransformer` has two answers for a name it does not know. Under
 * its test environment it throws; on a production build it prints a
 * console.warn, stores nothing, and returns false — and `registerValueTransformer`
 * hands that boolean back. Nothing here catches the throw: the registry wraps
 * `install()` and records the module as `failed` with the message, which the
 * popup prints beside the id. The false is the path that needed a hand: it is
 * the one a live forum takes, and a module that ignored it would read
 * "installed" over a list with no excerpts on it — the silent failure this
 * codebase refuses — so install() turns it into the same throw.
 *
 * `data-dfp-excerpts` is stamped on <html> once the registration has gone
 * through, so a stylesheet can tell the two list shapes apart. perf.css's
 * `contain-intrinsic-size: auto 79px` was measured without excerpts, and a
 * row that is really two lines taller than its placeholder is what makes the
 * scrollbar jump as rows enter the viewport. Stamped after the registration,
 * not before: if the registration throws there are no excerpts, and the
 * attribute must not say otherwise.
 */

/** Read by CSS: present once the transformer is registered, so rows may carry excerpts. */
const ROOT_FLAG = "data-dfp-excerpts";

/** The Discourse transformer that gates TopicExcerpt on a list row. */
export const EXPAND_PINNED = "topic-list-item-expand-pinned";

export function topicExcerpts(api: PluginApi): DfpModule {
  return {
    id: "topic-excerpts",
    /* Nothing here is charged: the callback is a constant the transformer
     * reads per row, and neither decorate.ts nor dom-watch.ts is involved, so
     * this is the alarm every module carries rather than a measurement. */
    budgetMs: 20,

    install() {
      /* `unknown`, not the declared void: types.ts describes the method as
       * returning nothing because nothing else reads its answer, and the only
       * value that means anything here is a literal false. */
      const ok: unknown = api.registerValueTransformer<boolean>(EXPAND_PINNED, () => true);
      if (ok === false) {
        throw new Error(
          `transformer "${EXPAND_PINNED}" refused (unknown on this Discourse build)`,
        );
      }
      document.documentElement.setAttribute(ROOT_FLAG, "1");
    },
  };
}
