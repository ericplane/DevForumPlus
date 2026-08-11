import type { DfpModule } from "../../core/registry";
import { chipStrip, loadGroups, usernameFromPath } from "../group-chips";
import type { PluginApi } from "../types";
import { onDomChange } from "../dom-watch";

/**
 * Show every group on a profile, as flair chips.
 *
 * Discourse renders two group links and then a literal third `<a>` containing
 * "…". That is markup, not CSS truncation — verified on the live page, where
 * the cell's `scrollWidth` equals its `clientWidth` and `overflow` is `visible`.
 * So no amount of width fixes it; the rest of the groups are simply not in the
 * document.
 *
 * `/u/{username}.json` has them, with flair attached — verified against a real
 * account: 8 groups, each carrying `flair_url`, `flair_bg_color`, `flair_color`.
 *
 * Icon AND name, not icon alone. Half the forum's groups have no flair at all —
 * 21 of 42 — so an icons-only strip would render blanks for the rest. The icon
 * is the decoration; the name is the information.
 *
 * The rendering itself lives in `../group-chips`, shared with user cards and
 * post bylines.
 */

const MARK = "data-dfp-groups";

/** The row is full-width here, so a generous cap: only the extreme cases fold. */
const LIMIT = 12;

function enhance(): void {
  const username = usernameFromPath(location.pathname);
  if (!username) return;

  const about = document.querySelector(".user-main .about");
  if (!about) return;

  // The groups cell is the one whose <dt> says so; matching on text avoids
  // depending on cell order, which differs by what a profile has filled in.
  const cells = [...about.querySelectorAll<HTMLElement>(".secondary dl > div")];
  const cell = cells.find((c) => /group/i.test(c.querySelector("dt")?.textContent ?? ""));
  const dd = cell?.querySelector("dd");
  if (!dd || dd.hasAttribute(MARK)) return;

  void loadGroups(username).then((groups) => {
    if (!groups.length || dd.hasAttribute(MARK) || !dd.isConnected) return;
    // Only claim the cell once there is something better to put in it.
    dd.setAttribute(MARK, "1");
    dd.replaceChildren(chipStrip(groups, LIMIT));
  });
}

export function profileGroups(api: PluginApi): DfpModule {
  return {
    id: "profile-groups",
    budgetMs: 60,

    install() {
      const run = () => {
        try {
          enhance();
        } catch {
          // A profile that renders differently must not lose its groups cell.
        }
      };
      api.onPageChange(() => {
        run();
        // The hero renders after the route settles, and expanding reveals the
        // strip for the first time.
        setTimeout(run, 400);
        setTimeout(run, 1200);
      });
      run();
      setTimeout(run, 400);
      setTimeout(run, 1200);

      /* Expanding the header mounts `.secondary` long after page change, and
       * that is the only place these chips live. */
      onDomChange(() => run());
    },
  };
}
