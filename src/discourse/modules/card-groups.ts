import type { DfpModule } from "../../core/registry";
import { chipStrip, loadGroups, usernameFromPath } from "../group-chips";
import type { PluginApi } from "../types";

/**
 * Group chips on the user card — the popover behind an avatar or a username.
 *
 * The card ships no group data at all. `/u/{name}/card.json` was checked
 * directly and returns zero groups; all it carries is the single flair already
 * drawn on the avatar. So the list comes from `/u/{name}.json`, one request per
 * member, cached — which is affordable here precisely because a card is opened
 * deliberately, one person at a time.
 *
 * The card mounts and unmounts on every open, so this watches for it rather
 * than running on page change.
 */

const MARK = "data-dfp-card-groups";

/** The card is ~570px wide: six chips fill two comfortable rows. */
const LIMIT = 6;

/** The card's own link to the profile is the only reliable username source. */
function usernameOf(card: Element): string | null {
  const link = card.querySelector<HTMLAnchorElement>('a.user-profile-link[href*="/u/"]');
  if (link) {
    const from = usernameFromPath(new URL(link.href, location.origin).pathname);
    if (from) return from;
  }
  const text = card.querySelector(".names__secondary.username")?.textContent?.trim();
  return text || null;
}

/* Ember mounts `.card-content` with all five of its rows already present, then
 * fills the user in once `card.json` resolves. Measured on the live forum: at
 * the mutation that adds the card there is no `.names` and no profile link —
 * only the empty skeleton — and both exist about a second later. Reading the
 * username at mutation time therefore always failed, which is why the first
 * version of this module rendered nothing at all. */
const RETRY_MS = 80;
const RETRIES = 25;

const ROW = "dfp-card-groups";

function enhance(card: HTMLElement, attempt = 0): void {
  if (!card.isConnected) return;

  const username = usernameOf(card);
  if (!username) {
    // Not ready yet, not absent. Stop early if the card closes.
    if (attempt < RETRIES) setTimeout(() => enhance(card, attempt + 1), RETRY_MS);
    return;
  }

  /* The mark stores *who* the card was filled in for, not merely that it was.
   *
   * Clicking a second avatar while a card is open makes Discourse close and
   * reopen in one Ember runloop, which can reuse the same `.card-content`
   * element for the new member. A boolean mark then reads as "already done"
   * and that card — and every member viewed in it afterwards — silently gets
   * no groups. Comparing usernames re-arms instead. */
  if (card.getAttribute(MARK) === username) return;
  card.setAttribute(MARK, username);

  void loadGroups(username).then((groups) => {
    // The card may have closed, or moved on to someone else, during the request.
    if (!card.isConnected || card.getAttribute(MARK) !== username) return;

    // Reused element: clear the previous member's row before adding this one.
    card.querySelector(`.${ROW}`)?.remove();
    if (!groups.length) return;

    const row = document.createElement("div");
    row.className = `card-row ${ROW}`;

    /* Without a label the chips read as more badges — the badge row sits
     * immediately below and looks near-identical. The card labels its own rows
     * POSTED / JOINED / READ, so this matches them; those use `.desc`, but that
     * class is scoped to `.metadata` and inherits nothing out here, so the look
     * is reproduced in group-chips.css instead. */
    const label = document.createElement("span");
    label.className = "dfp-card-groups__label";
    label.textContent = "Groups";

    row.append(label, chipStrip(groups, LIMIT));

    /* Above the badges, below the metadata — groups and badges are the same
     * kind of fact about a person, and this keeps them together. */
    const badges = card.querySelector(".badge-section")?.parentElement;
    if (badges && badges.parentElement === card) card.insertBefore(row, badges);
    else card.appendChild(row);
  });
}

const watched = new WeakSet<HTMLElement>();

/**
 * Re-run when the card's own contents change.
 *
 * The outer observer only fires on `addedNodes`, so a `.card-content` element
 * that Ember reuses for a second member is never seen again — the username
 * check in `enhance` would have nothing to re-arm it. Watching the card itself
 * supplies the trigger. It cannot loop: inserting the row mutates the card,
 * which calls `enhance` again, which returns immediately because the mark
 * already equals the current username.
 */
function watch(card: HTMLElement): void {
  if (watched.has(card)) return;
  watched.add(card);

  const inner = new MutationObserver(() => {
    if (!card.isConnected) {
      inner.disconnect();
      return;
    }
    enhance(card);
  });
  inner.observe(card, { childList: true, subtree: true });
}

function take(card: HTMLElement): void {
  watch(card);
  enhance(card);
}

function scan(root: ParentNode): void {
  for (const card of root.querySelectorAll<HTMLElement>(".card-content")) take(card);
}

export function cardGroups(_api: PluginApi): DfpModule {
  return {
    id: "card-groups",
    budgetMs: 4,

    install() {
      // A card open at install time (rare, but a re-enable can do it).
      scan(document);

      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.classList.contains("card-content")) take(node);
            else scan(node);
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    },
  };
}
