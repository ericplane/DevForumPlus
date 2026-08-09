import type { PluginApi } from "./types";

/**
 * `decorateCookedElement`, plus the posts that were already on screen.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * Reproduced on the live forum: hard-load a topic containing code and the M3
 * code intelligence does not run. Three `<pre><code>` blocks present,
 * `data-dfp` on the root so the CSS layer is live, and zero decorator markers —
 * no `data-dfp-code`, no `.dfp-luau`, no language label. Navigate to the same
 * topic from another page and all of it appears.
 *
 * The cause is in `boot.ts`, which says it plainly: rung 1 (the pre-boot define
 * trap) "is the only rung that catches the *first* render". When DFP lands on
 * rung 2 instead — Ember has already booted — every post rendered before
 * install is simply never handed to a decorator. Client-side navigation
 * re-renders the stream, which is why clicking through works and refreshing
 * does not.
 *
 * `decorateCookedElement` is a registration, not a scan: it says "call me for
 * cooked content from now on". So the fix is not to change the hook but to
 * cover the gap before it — decorate what is already here, then let the hook
 * handle everything after.
 *
 * Every caller must be idempotent, because an element can legitimately be seen
 * twice (once by the sweep, once by the hook). All three call sites already
 * guard with a data attribute; that is now a requirement rather than a
 * coincidence.
 * ───────────────────────────────────────────────────────────────────────────
 */

type Decorator = (element: HTMLElement) => void;

/**
 * Cooked content that has rendered already.
 *
 * `.cooked` is the class Discourse puts on every rendered post body, and is the
 * same element `decorateCookedElement` hands to a decorator — verified against
 * the live DOM, where a solved topic's post 1 contains two of them.
 */
function existingCooked(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".cooked")];
}

/**
 * Register a decorator and immediately apply it to what is already rendered.
 *
 * The sweep repeats on a short schedule rather than running once. Install can
 * land in the middle of Ember's first paint, so a single pass can run before
 * the posts exist — and the retries are close to free because every decorator
 * bails on its own guard attribute after the first visit.
 */
export function decorateCooked(
  api: PluginApi,
  fn: Decorator,
  opts: { id: string; onlyStream?: boolean },
): void {
  const safe = (element: HTMLElement) => {
    try {
      fn(element);
    } catch {
      // One bad post must never take out the rest of the sweep.
    }
  };

  api.decorateCookedElement((element) => safe(element), opts);

  const sweep = () => {
    for (const el of existingCooked()) safe(el);
  };

  /* Every pass is deferred, including the first.
   *
   * `install()` is measured: registry.ts wraps it in `measure()` and strikes
   * the module when it exceeds `budgetMs` (12ms for code-intel, 8ms for
   * code-chrome), and three strikes auto-disable it. Those budgets were set
   * when install was pure registration and cost ~0ms — the per-post work was
   * spread across Discourse's own decorate calls, where nothing measured it.
   *
   * A synchronous first sweep moves the entire first screen's tokenizing and
   * DOM building inside that measured window. Benchmarked on this repo's own
   * `segment()`, eight ~80-line Luau blocks cost ~11ms of tokenizing alone,
   * before any DOM work — so a code-heavy thread blows a 12ms budget, and the
   * fix that exists to make code intelligence appear would instead switch it
   * off on exactly the pages it was written for.
   *
   * A microtask runs before paint and before any user could notice, but after
   * install has returned and been measured. */
  queueMicrotask(sweep);
  // Further passes cover the window where Ember is still painting the first
  // screen. Anything later than this arrives through the hook.
  requestAnimationFrame(sweep);
  setTimeout(sweep, 400);
  setTimeout(sweep, 1500);
}
