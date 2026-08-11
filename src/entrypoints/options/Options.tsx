import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { getSettings, resetSettings, setSettings } from "../../core/settings";
import { MODULE_IDS, type DfpSettings, type ModuleId } from "../../core/settings-schema";
import { clearStrikes, readStrikes } from "../../core/bridge/isolated";

/**
 * The full settings surface.
 *
 * The popup answers "is it working, and what happened on this page" in 340px.
 * This answers "what is it doing, and how do I change it" — ten modules, each
 * of which needs a sentence saying what it actually does, because a list of
 * ids like `code-intel` and `stale-answer` tells nobody anything.
 *
 * Every module ships enabled; `settings.modules` only ever records exceptions.
 * That is why a missing key reads as on.
 */

interface ModuleInfo {
  title: string;
  blurb: string;
  /** Where you would notice it, so a toggle can be judged without guessing. */
  where: string;
}

const MODULES: Record<ModuleId, ModuleInfo> = {
  "topic-list-signals": {
    title: "Topic list signals",
    blurb: "Marks solved, busy, closed and long-dormant topics in any list.",
    where: "Topic lists",
  },
  "chart-theme": {
    title: "Chart theming",
    blurb: "Repaints Discourse's own charts to match the rest of the theme.",
    where: "Profiles, admin pages",
  },
  "profile-info": {
    title: "Profile layout",
    blurb: "Rebuilds the profile hero, stats and activity pages.",
    where: "/u/… pages",
  },
  prefetch: {
    title: "Hover prefetch",
    blurb:
      "Fetches a topic while you hover its link, so opening it is instant. " +
      "Replays the real request in the background so your read state still records.",
    where: "Topic lists",
  },
  "warm-cache": {
    title: "Warm cache",
    blurb: "Keeps recently-read topic bodies on disk so a revisit paints immediately.",
    where: "Topics",
  },
  "code-intel": {
    title: "Luau code intelligence",
    blurb:
      "Re-highlights Luau properly, marks deprecated APIs with their replacements, " +
      "and links names to Creator Docs. The forum highlights Luau with the Lua grammar.",
    where: "Any post with code",
  },
  "code-chrome": {
    title: "Code block controls",
    blurb: "Language label, soft-wrap toggle, copy-without-comments, and collapse for long blocks.",
    where: "Any post with code",
  },
  "stale-answer": {
    title: "Stale answer warning",
    blurb:
      "Flags replies over two years old that recommend APIs which have since been replaced. " +
      "Never shown on the opening post.",
    where: "Old topics",
  },
  "category-gate": {
    title: "Category gate notice",
    blurb: "Says you cannot start a topic in a group-restricted category before you write one.",
    where: "Bug Reports, some others",
  },
  "profile-groups": {
    title: "Group chips on profiles",
    blurb:
      "Shows every group a member belongs to, with its flair icon. Discourse lists two and an ellipsis.",
    where: "/u/… pages",
  },
  "card-groups": {
    title: "Group chips on user cards",
    blurb:
      "Adds the same chips to the card behind an avatar, which otherwise shows no groups at all. " +
      "Anything past six folds behind a “+N more”.",
    where: "User card popover",
  },
  "search-signals": {
    title: "Age marks in search results",
    blurb:
      "Flags results two years or older, where the advice is most likely to have been replaced. " +
      "Search is the one place you meet an old answer without any warning.",
    where: "/search",
  },
  facepile: {
    title: "Fold long like lists",
    blurb:
      "Shows twelve faces and a “+N others” toggle when you expand who liked a post, instead of dropping all of them into the page. " +
      "Nobody is hidden — one click brings the rest back.",
    where: "Topics",
  },
  "post-groups": {
    title: "Group chip in post bylines",
    blurb:
      "Names the flair group next to the poster instead of leaving it as an unlabelled badge on the avatar. " +
      "One group only — a post carries no more than that, and fetching the rest would cost a request per author.",
    where: "Topics",
  },
  "thread-view": {
    title: "Thread view",
    blurb:
      "Adds a toggle that indents replies by depth so a long argument is followable. " +
      "Keeps chronological order, so permalinks and find-in-page still work.",
    where: "Topic footer",
  },
  "quiet-replies": {
    title: "Quiet replies",
    blurb:
      "Adds a toggle that folds runs of replies carrying no information — \"thanks\", \"+1\", \"bump\" — " +
      "into one line you can expand. Never folds the opening post, an accepted answer, a reply " +
      "someone answered, or anything containing code.",
    where: "Topic timeline",
  },
  "asset-preview": {
    title: "Asset previews",
    blurb:
      "Turns rbxassetid:// references and Roblox catalog links into real links, with a thumbnail " +
      "on hover. The thumbnail is fetched only when you point at one.",
    where: "Any post referencing an asset",
  },
  "topic-preview": {
    title: "Topic previews",
    blurb:
      "Hovering a link to another thread shows its title, whether it was solved, and how " +
      "old it is — so a six-year-old answer is obvious before you click. Uses the same " +
      "request DFP already makes to open a topic, and never contacts anything but the forum.",
    where: "Any post linking a thread",
  },
  "docs-links": {
    title: "Creator Docs links",
    blurb:
      "Gives a Creator Docs link in a post the same hover card the API names inside code " +
      "blocks already get. Reads the docs index that ships with the extension, so it makes " +
      "no request at all.",
    where: "Any post linking the docs",
  },
  "op-pin": {
    title: "Pin the opening post",
    blurb:
      "Adds a toggle that keeps the opening post in a column beside the replies, " +
      "scrolling on its own. Off by default; wide screens only, on topics with a few replies.",
    where: "Topic timeline",
  },
};

export function Options(): JSX.Element {
  const [settings, setLocal] = useState<DfpSettings | null>(null);
  const [strikes, setStrikeState] = useState<Partial<Record<ModuleId, number>>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getSettings().then(setLocal);
    void readStrikes().then(setStrikeState);
  }, []);

  const update = async (patch: Partial<DfpSettings>) => {
    const next = await setSettings(patch);
    setLocal(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
  };

  const toggleModule = (id: ModuleId, on: boolean) => {
    if (!settings) return;
    void update({ modules: { ...settings.modules, [id]: on } });
  };

  if (!settings) {
    return (
      <main class="opt">
        <div class="skeleton-page" aria-busy="true" aria-label="Loading settings" />
      </main>
    );
  }

  const disabledCount = MODULE_IDS.filter((id) => settings.modules[id] === false).length;

  return (
    <main class="opt">
      <header class="opt__head">
        <h1>DevForum Plus</h1>
        <p class="opt__sub">
          Every feature is on unless you turn it off here. Changes apply to the next page
          you load.
        </p>
        <span class="opt__saved" data-on={saved ? "1" : "0"} role="status">
          Saved
        </span>
      </header>

      <section class="opt__section">
        <h2>Features</h2>
        <p class="opt__note">
          {disabledCount === 0
            ? `All ${MODULE_IDS.length} features are on.`
            : `${disabledCount} of ${MODULE_IDS.length} turned off.`}
        </p>

        <ul class="mods">
          {MODULE_IDS.map((id) => {
            const info = MODULES[id];
            const on = settings.modules[id] !== false;
            const struck = strikes[id] ?? 0;
            return (
              <li class="mod" key={id}>
                <label class="mod__row">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      toggleModule(id, (e.currentTarget as HTMLInputElement).checked)
                    }
                  />
                  <span class="mod__text">
                    <span class="mod__title">
                      {info.title}
                      <span class="mod__where">{info.where}</span>
                      {struck > 0 && (
                        /* Surfaced rather than hidden: a module that keeps
                         * blowing its budget is disabled automatically, and
                         * silently vanishing is worse than saying so. */
                        <span class="mod__strike" title={`${struck} slow installs recorded`}>
                          {struck >= 3 ? "auto-disabled" : `${struck}/3 slow`}
                        </span>
                      )}
                    </span>
                    <span class="mod__blurb">{info.blurb}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {Object.values(strikes).some((n) => (n ?? 0) > 0) && (
          <button
            class="opt__btn"
            onClick={() => {
              void clearStrikes().then(() => setStrikeState({}));
            }}
          >
            Reset performance strikes
          </button>
        )}
      </section>

      <section class="opt__section">
        <h2>Reset</h2>
        <p class="opt__note">
          Puts every setting back to its default, including the theme and the feature list.
        </p>
        <button
          class="opt__btn opt__btn--danger"
          onClick={() => {
            void resetSettings().then(setLocal);
          }}
        >
          Reset all settings
        </button>
      </section>
    </main>
  );
}
