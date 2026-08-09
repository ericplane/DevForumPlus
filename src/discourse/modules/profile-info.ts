import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";

/**
 * Surface trust level and account age on user profiles.
 *
 * Discourse shows a user's trust level nowhere on their profile. On this forum
 * that is the single most asked-about number a person has — "how do I get TL3"
 * is a perennial thread — and it is already sitting on the user model the page
 * has loaded. Showing it costs one DOM node.
 *
 * Scope note: this reports the level, it does not estimate progress toward the
 * next one. Progress needs the instance's configured thresholds, and the
 * endpoint that used to expose them (`/u/:username/trust_level_3_requirements`)
 * returns 404 here — so a progress bar would be a guess dressed up as a fact.
 * See PLAN.md §7.2.
 */

const CHIPS_CLASS = "dfp-profile-chips";

/** Names as this instance defines them (verified against site.json). */
const TRUST_LEVELS: Record<number, string> = {
  0: "New user",
  1: "Basic",
  2: "Member",
  3: "Regular",
  4: "Leader",
};

interface ProfileUser {
  username?: string;
  trust_level?: number;
  created_at?: string;
  admin?: boolean;
  moderator?: boolean;
  badge_count?: number;
}

function chip(text: string, variant?: string, title?: string): HTMLElement {
  const el = document.createElement("span");
  el.className = variant ? `dfp-chip dfp-chip--${variant}` : "dfp-chip";
  if (title) el.title = title;
  const dot = document.createElement("span");
  dot.className = "dfp-chip__dot";
  el.append(dot, document.createTextNode(text));
  return el;
}

/** "Member for 8 years" reads better than a raw join date on a profile. */
function accountAge(createdAt: string): string | null {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 0) return null;
  if (days < 31) return `Member for ${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `Member for ${months} month${months === 1 ? "" : "s"}`;
  return `Member for ${Math.floor(days / 365.25)} years`;
}

function render(user: ProfileUser): void {
  const names = document.querySelector(".user-main .primary-textual");
  if (!names) return;

  // Idempotent: onPageChange fires on every profile subpage, and Ember may
  // re-render the hero underneath us.
  names.querySelector(`.${CHIPS_CLASS}`)?.remove();

  const chips: HTMLElement[] = [];

  if (user.admin || user.moderator) {
    chips.push(chip(user.admin ? "Admin" : "Moderator", "staff"));
  }

  if (typeof user.trust_level === "number") {
    const name = TRUST_LEVELS[user.trust_level] ?? `Level ${user.trust_level}`;
    chips.push(chip(`TL${user.trust_level} · ${name}`, "tl", "Discourse trust level"));
  }

  if (typeof user.badge_count === "number" && user.badge_count > 0) {
    chips.push(chip(`${user.badge_count} badges`));
  }

  if (user.created_at) {
    const age = accountAge(user.created_at);
    if (age) {
      chips.push(chip(age, undefined, new Date(user.created_at).toLocaleDateString()));
    }
  }

  if (chips.length === 0) return;

  const row = document.createElement("div");
  row.className = CHIPS_CLASS;
  row.append(...chips);
  names.append(row);
}

type Container = { lookup: (key: string) => unknown };

/**
 * The boot ladder does not thread Ember's owner through, so resolve the
 * container from the plugin API — falling back to the global the main world can
 * always see. Either way this stays inside the page's own JS world.
 */
function resolveContainer(api: PluginApi): Container | null {
  const fromApi = (api as { container?: unknown }).container;
  if (fromApi && typeof (fromApi as Container).lookup === "function") {
    return fromApi as Container;
  }
  const global = (window as { Discourse?: { __container__?: unknown } }).Discourse
    ?.__container__;
  if (global && typeof (global as Container).lookup === "function") {
    return global as Container;
  }
  return null;
}

export function profileInfo(api: PluginApi): DfpModule {
  return {
    id: "profile-info",
    budgetMs: 3,

    isAvailable() {
      return resolveContainer(api) !== null;
    },

    install() {
      const container = resolveContainer(api);
      if (!container) return;

      api.onPageChange(() => {
        // Only user routes have a profile hero to decorate.
        const router = container.lookup("service:router") as
          | { currentRouteName?: string }
          | undefined;
        if (!router?.currentRouteName?.startsWith("user")) return;

        const controller = container.lookup("controller:user") as
          | { model?: ProfileUser }
          | undefined;
        const user = controller?.model;
        if (!user) return;

        // The hero renders after the route settles; a frame is enough, and
        // failing to find it simply means no chips this time.
        requestAnimationFrame(() => {
          try {
            render(user);
          } catch {
            /* never let profile decoration break the page */
          }
        });
      });
    },
  };
}
