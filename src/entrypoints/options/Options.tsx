import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { getSettings, resetSettings, setSettings } from "../../core/settings";
import {
  DEFAULT_OFF,
  DENSITIES,
  FONT_SCALE_LABELS,
  FONT_SCALES,
  MODULE_IDS,
  MOTIONS,
  RADII,
  THEMES,
  WIDTH_NOTE,
  WIDTHS,
  fontScaleLabel,
  isModuleEnabled,
  type DfpSettings,
  type ModuleId,
} from "../../core/settings-schema";
import { clearStrikes, readStrikes } from "../../core/bridge/isolated";
import { Segmented } from "../shared/Segmented";

/**
 * The full settings surface.
 *
 * The popup answers "is it working, and what happened on this page" in 340px.
 * This answers "what is it doing, and how do I change it" — every module, each
 * of which needs a sentence saying what it actually does, because a list of
 * ids like `code-intel` and `stale-answer` tells nobody anything. (This said
 * "ten modules" while the schema listed twenty; the count lives in MODULE_IDS
 * and nowhere else.)
 *
 * `settings.modules` only ever records exceptions, and a missing key reads as
 * on — except for the ids in DEFAULT_OFF, which ship switched off. Both the
 * checkbox and the count go through isModuleEnabled so this page cannot show
 * a module as on that the registry treats as off.
 *
 * The Appearance section duplicates the popup's rows on purpose: the two
 * settings surfaces were disjoint — the popup had the knobs and no feature
 * switches, this page had the switches and no knobs — and neither pointed at
 * the other. Same Segmented component, same tables from settings-schema.ts.
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
  "topic-excerpts": {
    title: "Row excerpts",
    blurb:
      "Shows the first two lines of every topic under its title in any list. The server " +
      "already sends them; this only asks Discourse to render them. Two extra lines per row, " +
      "so it is off until you want it.",
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
    /* "Topic timeline", like op-pin and quiet-replies: the toggle lives in the
     * timeline rail (thread-view.ts explains the move), and the footer it used
     * to name does not render until the last post is reached. */
    where: "Topic timeline",
  },
  "quiet-replies": {
    title: "Quiet replies",
    blurb:
      "Adds a toggle that folds runs of replies carrying no information — \"thanks\", \"+1\", \"bump\" — " +
      "into one line you can expand. Never folds the opening post, an accepted answer, a reply " +
      "someone answered, or anything containing code.",
    where: "Topic timeline",
  },
  "timeline-marks": {
    title: "Timeline marks",
    blurb:
      "Ticks on the topic scrubber for every staff reply and the accepted answer, so a long " +
      "Bug Report answers \"did Roblox reply\" without scrolling it. Hover names the post; " +
      "click jumps to it.",
    where: "Topics",
  },
  "post-numbers": {
    title: "Post numbers in bylines",
    blurb:
      "Shows each post's number (#42) before its date, inside the permalink, so a reference " +
      "like \"see #42\" can be matched while scrolling.",
    where: "Topics",
  },
  "asset-preview": {
    title: "Asset previews",
    blurb:
      "Turns rbxassetid:// references and Roblox catalog, game, group and profile links into " +
      "real links, with a card on hover: the asset's picture, name and kind, or a group's or " +
      "user's icon, name and size. Everything is fetched only when you point at one, from page " +
      "context, with no cookies attached.",
    where: "Any post referencing an asset",
  },
  "topic-preview": {
    title: "Topic previews",
    blurb:
      "Hovering a link to another thread shows its category, title, whether it was solved, and " +
      "how old it is — so a six-year-old answer is obvious before you click. Uses the same " +
      "request DFP already makes to open a topic, plus one category-table request per visit, " +
      "and never contacts anything but the forum.",
    where: "Any post linking a thread",
  },
  "docs-links": {
    title: "Creator Docs links",
    blurb:
      "Gives a Creator Docs link in a post the same hover card the API names inside code " +
      "blocks already get. Reference pages come from the docs index that ships with the " +
      "extension; other docs pages are looked up on hover.",
    where: "Any post linking the docs",
  },
  "op-pin": {
    title: "Pin the opening post",
    blurb:
      "Adds a toggle that keeps the opening post in a column beside the replies, " +
      "scrolling on its own. Off by default; windows 1280px and wider, on topics with a few replies.",
    where: "Topic timeline",
  },
  composer: {
    title: "Composer tools",
    blurb:
      "Checks for already-asked topics while you type a title, keeps an unsent-draft vault, " +
      "adds a Luau code-block button, and fences Luau you paste.",
    where: "Composer",
  },
  "command-palette": {
    title: "Command palette",
    blurb:
      "Ctrl+K / ⌘K (or the button beside the header search icon) opens instant search over " +
      "topics and categories, filter chips for Discourse's search syntax, and DevForum Plus " +
      "commands — theme, density, width, thread view, settings. Selections route in-app rather " +
      "than reloading the page. While the composer's editor has focus the chord yields to " +
      "Discourse's own insert-link shortcut; the header button still opens the palette.",
    where: "Everywhere — Ctrl+K / ⌘K, or the button beside the header search icon",
  },
  "recent-topics": {
    title: "Recent topics in the palette",
    blurb:
      "Remembers the last twelve topics this browser opened and lists them when the palette " +
      "opens, before you type. Stored on this device only, never sent anywhere; switching this " +
      "off clears the list.",
    where: "Ctrl+K palette, before typing",
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

  const disabledCount = MODULE_IDS.filter((id) => !isModuleEnabled(settings, id)).length;

  return (
    <main class="opt">
      <header class="opt__head">
        <h1>DevForum Plus</h1>
        <p class="opt__sub">
          Almost every feature is on unless you turn it off here. Appearance changes apply
          at once; feature changes apply to the next page you load.
        </p>
        <span class="opt__saved" data-on={saved ? "1" : "0"} role="status">
          Saved
        </span>
      </header>

      <section class="opt__section">
        <h2>Appearance</h2>
        <p class="opt__note">
          Applies immediately in any open forum tab — unlike the features below, nothing
          needs a reload.
        </p>
        <div class="opt__controls">
          <Segmented
            label="Theme"
            options={THEMES}
            value={settings.theme}
            onPick={(theme) => void update({ theme })}
          />
          <Segmented
            label="Density"
            options={DENSITIES}
            value={settings.density}
            onPick={(density) => void update({ density })}
          />
          <Segmented
            label="Corners"
            options={RADII}
            value={settings.radius}
            onPick={(radius) => void update({ radius })}
          />
          <Segmented
            label="Width"
            options={WIDTHS}
            value={settings.width}
            onPick={(width) => void update({ width })}
            describe={(width) => WIDTH_NOTE[width]}
          />
          <Segmented
            label="Motion"
            options={MOTIONS}
            value={settings.motion}
            onPick={(motion) => void update({ motion })}
          />
          <Segmented
            label="Text size"
            options={FONT_SCALE_LABELS}
            value={fontScaleLabel(settings.fontScale)}
            onPick={(label) => void update({ fontScale: FONT_SCALES[label] })}
            describe={(label) => `${Math.round(FONT_SCALES[label] * 100)}%`}
          />
        </div>
      </section>

      <section class="opt__section">
        <h2>Features</h2>
        <p class="opt__note">
          {disabledCount === 0
            ? `All ${MODULE_IDS.length} features are on.`
            : `${disabledCount} of ${MODULE_IDS.length} off.`}
        </p>

        <ul class="mods">
          {MODULE_IDS.map((id) => {
            const info = MODULES[id];
            const on = isModuleEnabled(settings, id);
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
                      {DEFAULT_OFF.has(id) && (
                        /* The count above reads "1 of N off" on a fresh install;
                         * without this tag the reader hunts for what they
                         * switched. Same tag style as `where`, since it answers
                         * the same question: why is this row the way it is. */
                        <span class="mod__where">off by default</span>
                      )}
                      {struck > 0 && (
                        /* Surfaced rather than hidden: a module that keeps
                         * blowing its budget is disabled automatically, and
                         * silently vanishing is worse than saying so. */
                        <span class="mod__strike" title={`${struck} slow routes recorded`}>
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
        {/* The popup is the only surface with the boot rung, per-module ms and
          * strike counts; a reader who opened this page from the store listing
          * had no route to any of that. */}
        <p class="opt__note">
          How DFP attached on the current page, and how long each feature is taking, is in
          the toolbar popup.
        </p>
      </section>
    </main>
  );
}
