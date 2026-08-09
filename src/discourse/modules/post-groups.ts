import type { DfpModule } from "../../core/registry";
import { chip, type GroupLike } from "../group-chips";
import type { PluginApi } from "../types";

/**
 * The flair group as a named chip in the post byline.
 *
 * One chip, not a list, and that is a data limit rather than a design choice: a
 * post's payload carries exactly one group — `flair_name`, `flair_url`,
 * `flair_bg_color` — and nothing else. Showing every group a poster belongs to
 * would mean a request per author, and a long topic has dozens of them.
 *
 * So this reads what is already on screen. Discourse renders the flair onto the
 * avatar as `.avatar-flair.avatar-flair-{GroupName}` with the colours inline and
 * the icon as either a sprite reference or a background image. Every field the
 * chip needs is in that element, so this module issues no requests at all.
 *
 * The badge on the avatar is 16px of colour with no label; the chip is the same
 * fact with the group's name attached, and it links to the group.
 */

const MARK = "data-dfp-post-group";
const PREFIX = "avatar-flair-";

/**
 * Does the byline's title already say what the chip would say?
 *
 * Discourse defaults a member's title to their primary group's, so most of the
 * time the two are the same fact spelled differently — "Programmers" the group,
 * "Programmer" the title. Measured across 195 posts in 14 topics: 89 carried
 * both, 74 of them (83%) matched this way. The remaining 15 genuinely differed
 * — `Builders` with "Game Designer", `Web_Developer` with "Programmer" — and
 * there both are worth showing.
 *
 * Punctuation and case go (group names are `UI_Designers`), then one trailing
 * `s`, which is the whole of the difference in every matching pair sampled.
 */
function sameFact(group: string, title: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .replace(/s$/, "");
  const g = norm(group);
  return g.length > 0 && g === norm(title);
}

/** Rebuild the group record from the rendered flair badge. */
function groupFromFlair(flair: HTMLElement): GroupLike | null {
  const cls = [...flair.classList].find((c) => c.startsWith(PREFIX));
  const name = cls?.slice(PREFIX.length);
  if (!name) return null;

  const style = getComputedStyle(flair);

  // Sprite id (`<use href="#scroll">`) or, for the staff groups, an upload
  // that Discourse paints as a background image.
  const href = flair.querySelector("use")?.getAttribute("href") ?? "";
  let flairUrl: string | null = href.startsWith("#") ? href.slice(1) : null;
  if (!flairUrl) {
    const m = /url\((['"]?)(.*?)\1\)/.exec(style.backgroundImage);
    if (m?.[2]) flairUrl = m[2];
  }

  return {
    name,
    flair_url: flairUrl,
    // A background image supplies its own colour; a sprite needs the pair.
    flair_bg_color: flairUrl && /^https?:|^\//.test(flairUrl) ? null : style.backgroundColor,
    flair_color: style.color,
  };
}

function enhance(article: HTMLElement): void {
  const names = article.querySelector<HTMLElement>(".topic-meta-data .names");
  if (!names || names.hasAttribute(MARK)) return;

  const flair = article.querySelector<HTMLElement>(".avatar-flair");
  if (!flair) return;

  const group = groupFromFlair(flair);
  if (!group) return;

  names.setAttribute(MARK, "1");

  /* The chip is additive, never a replacement.
   *
   * An earlier version hid the title and showed the chip in its place whenever
   * the two matched. That removed the duplication but produced something worse:
   * only about half of posters set flair at all, so one byline read "Programmer"
   * as plain text and the next read "Programmers" as an icon pill, for what is
   * the same role. Leaving the title alone means every byline has the same
   * baseline, and a chip appears only where it carries a fact the title does
   * not — `Builders` next to "Game Designer", say. */
  const title = names.querySelector(".user-title")?.textContent?.trim();
  if (title && sameFact(group.name, title)) return;

  const c = chip(group);
  c.classList.add("dfp-group-chip--byline");
  /* `.names` is itself the user-card trigger. Without this, following the
   * group link also pops the card open over the page being left. */
  c.addEventListener("click", (e) => e.stopPropagation());
  names.appendChild(c);
}

function scan(root: ParentNode): void {
  for (const a of root.querySelectorAll<HTMLElement>("article[data-post-id]")) enhance(a);
}

export function postGroups(api: PluginApi): DfpModule {
  return {
    id: "post-groups",
    budgetMs: 6,

    install() {
      const run = () => {
        try {
          scan(document);
        } catch {
          // A byline that renders differently must not break the post.
        }
      };

      // Deferred: a synchronous first sweep is charged to install()'s budget,
      // and a long topic would spend it before the module ever runs.
      queueMicrotask(run);
      api.onPageChange(() => setTimeout(run, 120));

      // Posts stream in as you scroll.
      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches("article[data-post-id]")) enhance(node);
            else scan(node);
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    },
  };
}
