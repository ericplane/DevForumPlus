import {
  DEFAULT_SETTINGS,
  TRIM_RULESETS,
  normalizeSettings,
  type DfpSettings,
} from "../core/settings-schema";

/**
 * Service worker.
 *
 * Deliberately near-empty for M0/M1. Its only current jobs are seeding default
 * settings and opening up `chrome.storage.session` so content scripts can write
 * diagnostics to it — session storage defaults to trusted contexts only, so
 * without this the bridge's `diag:push` would fail silently.
 */
/**
 * Network trimming is enabled per-ruleset from settings and never by default.
 *
 * The baseline measurement is the honest context here: first load on this forum
 * is server-bound — 2427ms of the 2716ms to first paint is TTFB — so removing a
 * decorative script saves real bytes but very little wall-clock. It is offered
 * because some people want it, not because it is the win.
 */
async function syncTrimRulesets(settings: DfpSettings): Promise<void> {
  try {
    const enable: string[] = [];
    const disable: string[] = [];
    for (const id of TRIM_RULESETS) {
      (settings.trimNetwork[id] === true ? enable : disable).push(id);
    }
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable,
    });
  } catch {
    // Older Chromium, or the ruleset failed to parse. Trimming simply stays
    // off; nothing else depends on it.
  }
}


/**
 * Creator Docs page metadata, fetched here because nowhere else can.
 *
 * create.roblox.com sends no CORS headers — a fetch from the page fails with
 * `TypeError: Failed to fetch`, measured — so the content script cannot read
 * it. The service worker can, because host_permissions declares the origin.
 *
 * ── The path is never trusted ───────────────────────────────────────────────
 * The caller passes a PATH, not a URL, and it is matched against a fixed
 * pattern before the URL is rebuilt here from a hardcoded origin. That matters:
 * the path originates in someone else's forum post, and a worker that fetched
 * whatever it was handed would be a request forwarder for any page that could
 * reach the content script. `credentials: "omit"` for the same reason.
 *
 * Extraction is by regex rather than DOM: a service worker has no DOMParser,
 * and only text is ever taken — nothing parsed here is inserted anywhere.
 */
const DOCS_PATH = /^\/(?:[a-z]{2}-[a-z]{2}\/)?docs\/[\w/-]{1,200}$/;

/** Session-lived. The worker is torn down constantly, which bounds it for us. */
const docsMeta = new Map<string, { title: string; description: string } | null>();

async function fetchDocsMeta(path: string) {
  if (!DOCS_PATH.test(path)) return null;
  const hit = docsMeta.get(path);
  if (hit !== undefined) return hit;

  let meta: { title: string; description: string } | null = null;
  try {
    const res = await fetch(`https://create.roblox.com${path}`, { credentials: "omit" });
    if (res.ok) {
      /* Only the head is needed and these pages are large, so the body is read
       * in chunks and abandoned once both tags are in hand. */
      const html = (await res.text()).slice(0, 60_000);
      const pick = (prop: string) =>
        new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i")
          .exec(html)?.[1] ??
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i")
          .exec(html)?.[1] ??
        "";
      const title = pick("og:title") || /<title[^>]*>([^<]{1,300})</i.exec(html)?.[1] || "";
      const description = pick("og:description") || pick("description");
      if (title) {
        meta = { title: cleanTitle(decodeEntities(title)), description: decodeEntities(description) };
      }
    }
  } catch {
    // Offline, blocked, or Roblox changed shape. A missing card is the floor.
  }

  if (docsMeta.size > 64) docsMeta.delete(docsMeta.keys().next().value as string);
  docsMeta.set(path, meta);
  return meta;
}

/**
 * Roblox suffixes every docs title with its own branding — measured:
 * "Classic and Dynamic head comparison | Documentation - Roblox Creator Hub".
 * In a 360px card that boilerplate is most of the line and none of the meaning.
 */
function cleanTitle(t: string): string {
  return t.replace(/\s*[|–-]\s*(Documentation\s*[|–-]\s*)?Roblox Creator Hub\s*$/i, "").trim() || t;
}

/** The five XML entities, which is all a meta attribute can legally carry. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export default defineBackground(() => {
  /* Must be called on every worker start, not just on install: access level is
   * per-session, and the worker is torn down and restarted constantly.
   *
   * Optional-called because `setAccessLevel` is Chromium-only. On Firefox the
   * property is undefined, and calling it would throw synchronously — which a
   * trailing `.catch()` cannot see, so this would have taken the whole
   * background script down at startup rather than degrading. Firefox has no
   * equivalent because its content scripts cannot read `storage.session` at
   * all; diagnostics simply report unavailable there, which they already
   * handle. */

  /* Docs page metadata for the isolated world's hover card. Returns `true` to
   * keep the message channel open for the async reply — omitting that is the
   * classic way this silently answers `undefined`. */
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.type !== "dfp:docs-page" || typeof msg.path !== "string") return undefined;
    void fetchDocsMeta(msg.path).then(respond);
    return true;
  });

  chrome.storage.session
    .setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    ?.catch(() => {
      // Older Chromium, or already set. Diagnostics degrade to unavailable.
    });

  // Rulesets are session-independent but settings can change from any surface,
  // so reconcile on start and on every write.
  void chrome.storage.sync.get("settings").then((stored) =>
    syncTrimRulesets(normalizeSettings(stored["settings"])),
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes["settings"]) return;
    void syncTrimRulesets(normalizeSettings(changes["settings"].newValue));
  });

  /* `chrome.runtime.openOptionsPage` exists only in an extension context, so
   * the onboarding card in the content script asks for it by message rather
   * than the content script needing any extra capability. The message shape is
   * checked because content scripts share an origin with the page. */
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { t?: unknown }).t === "dfp:open-options"
    ) {
      void chrome.runtime.openOptionsPage().catch(() => {});
    }
    // No async response; returning false keeps the channel from being held open.
    return false;
  });

  chrome.runtime.onInstalled.addListener(async (details) => {
    const stored = await chrome.storage.sync.get("settings");
    if (stored["settings"] === undefined) {
      await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    } else {
      // Re-normalize on update so a schema change can never leave a user
      // stranded on an unreadable settings object.
      await chrome.storage.sync.set({
        settings: normalizeSettings(stored["settings"]),
      });
    }

    if (details.reason === "install") {
      // Strike counters are meaningless across a fresh install.
      await chrome.storage.local.remove("moduleStrikes");
    }
  });
});
