import type { DfpSettings, ModuleId } from "../settings-schema";
import { MODULE_IDS } from "../settings-schema";
import type { ModuleRecord, ModuleStatus } from "../registry";

/**
 * Wire protocol between the MAIN and ISOLATED content scripts.
 *
 * ── Threat model ────────────────────────────────────────────────────────────
 * The handshake uses `window.postMessage`, and every listener on that window —
 * including page scripts — receives the event and could take the transferred
 * port. We accept that, deliberately, for two reasons:
 *
 *   1. The bridge surface is intentionally boring: read settings, read/bump
 *      strike counters, push diagnostics, and — the other way — ask Discourse
 *      to route to a same-origin path. There is no privileged capability on
 *      the other end to steal: a page script holding the port could make the
 *      forum navigate to one of its own paths, which `location.assign` already
 *      lets any page script do. The ISOLATED side re-validates every inbound
 *      message and never passes MAIN-supplied data into a chrome.* call
 *      unchecked; MAIN re-validates the route path before handing it to the
 *      router.
 *   2. The only code that could race us is first-party Discourse. User-authored
 *      forum content cannot execute JS at all here — the site sends
 *      `script-src 'nonce-…' 'strict-dynamic'`, so an injected <script> in a
 *      post never runs.
 *
 * If the bridge ever grows a capability worth stealing, this comment stops
 * being true and the transport needs to change.
 * ───────────────────────────────────────────────────────────────────────────
 */

export const HANDSHAKE_TYPE = "__dfp_bridge_offer__";
export const MAIN_READY_TYPE = "__dfp_main_ready__";

export interface HandshakeMessage {
  type: typeof HANDSHAKE_TYPE;
  /** Per-load random value; lets MAIN ignore replayed or stale offers. */
  nonce: string;
}

export interface MainReadyMessage {
  type: typeof MAIN_READY_TYPE;
}

/** Which rung of the boot ladder actually got us in. Surfaced in the popup. */
export type BootRung = "pre-boot" | "post-boot" | "css-only";

export interface Diagnostics {
  rung: BootRung;
  /** Discourse's advertised PLUGIN_API_VERSION, if we could read it. */
  pluginApiVersion: string | null;
  /** ms from content-script start to a usable plugin API. */
  bootMs: number;
  modules: ModuleRecord[];
  notes: string[];
}

export type Request =
  | { id: number; t: "settings:get" }
  | { id: number; t: "strikes:get" }
  | { id: number; t: "strikes:bump"; module: ModuleId; ms: number }
  /* Cleared when a route ends with the module under budget — see registry.ts
   * endRoute(). Install clears nothing. */
  | { id: number; t: "strikes:clear"; module: ModuleId }
  | { id: number; t: "diag:push"; diagnostics: Diagnostics };

export type Response =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

/**
 * ISOLATED → MAIN, unsolicited. `nav:route` is how the ⌘K palette navigates:
 * the palette lives in the ISOLATED world, which cannot reach Discourse's
 * router, and a `location.assign` from there is a full document load —
 * measured at 2427ms of TTFB before first paint against the ~465ms JSON call
 * an in-app transition costs (perf.css, prefetch.ts). MAIN hands the path to
 * `DiscourseURL.routeTo`, the same call every intercepted link click makes.
 *
 * A Push rather than a Request because the reply would carry nothing: MAIN
 * either routes or, when the router is unreachable, falls back to a document
 * load itself. The ISOLATED side only needs to know whether MAIN is there at
 * all, which it learns from the first request MAIN sends (isolated.ts).
 */
export type Push =
  | { t: "settings:changed"; settings: DfpSettings }
  | { t: "nav:route"; href: string };

export type Inbound = Response | Push;

// ── Validators ──────────────────────────────────────────────────────────────
// Hand-rolled rather than pulled from a schema library: this code ships inside
// a content script that runs at document_start on every page load, and eight
// message shapes do not justify the bytes.

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isModuleId = (v: unknown): v is ModuleId =>
  typeof v === "string" && (MODULE_IDS as readonly string[]).includes(v);

/* A total record rather than an array, for the same reason protocol.test.ts
 * types its samples that way: registry.ts adding a status without listing it
 * here is a compile error, not a diagnostics push that silently fails
 * validation on arrival. */
const MODULE_STATUS: Record<ModuleStatus, true> = {
  installed: true,
  "disabled-by-user": true,
  "auto-disabled": true,
  failed: true,
  unavailable: true,
};

const isModuleStatus = (v: unknown): v is ModuleStatus =>
  typeof v === "string" && Object.hasOwn(MODULE_STATUS, v);

export function isHandshake(v: unknown): v is HandshakeMessage {
  return isObj(v) && v["type"] === HANDSHAKE_TYPE && typeof v["nonce"] === "string";
}

export function isMainReady(v: unknown): v is MainReadyMessage {
  return isObj(v) && v["type"] === MAIN_READY_TYPE;
}

/**
 * Runs on the ISOLATED side, where the sender is not fully trusted.
 *
 * Every variant of `Request` needs a case here. The `default` fails closed,
 * which is the right default for a validator but makes an omission silent and
 * one-directional: `strikes:clear` was in the union and handled on both ends,
 * yet dropped here for its whole life. The visible symptom was not an error but
 * a counter that could only ever go up — so a module that went over budget on
 * three slow loads spread across months stayed auto-disabled for good, which is
 * the opposite of the "consecutive failures" rule registry.ts documents.
 *
 * TypeScript cannot catch this: `v["t"]` is `unknown`, so an unlisted case is
 * indistinguishable from a hostile message. tests/unit/protocol.test.ts asserts
 * every variant round-trips instead.
 */
export function isRequest(v: unknown): v is Request {
  if (!isObj(v) || typeof v["id"] !== "number") return false;
  switch (v["t"]) {
    case "settings:get":
    case "strikes:get":
      return true;
    case "strikes:bump":
      return isModuleId(v["module"]) && typeof v["ms"] === "number";
    case "strikes:clear":
      return isModuleId(v["module"]);
    case "diag:push":
      return isDiagnostics(v["diagnostics"]);
    default:
      return false;
  }
}

/**
 * Every field the popup and overlay read, typed as it is read. `modules` used
 * to pass as "any array", which was fine while the isolated side only stored
 * it, but the popup now does arithmetic on `workMs` and `budgetMs` and a
 * record without them would render "NaN / undefined ms" rather than fail.
 */
function isModuleRecord(v: unknown): v is ModuleRecord {
  return (
    isObj(v) &&
    isModuleId(v["id"]) &&
    isModuleStatus(v["status"]) &&
    typeof v["installMs"] === "number" &&
    typeof v["workMs"] === "number" &&
    typeof v["budgetMs"] === "number" &&
    typeof v["strikes"] === "number" &&
    (v["error"] === undefined || typeof v["error"] === "string")
  );
}

/* Exported because isolated.ts also reads diagnostics back out of
 * storage.local, where an older build may have left a record of a different
 * shape. */
export function isDiagnostics(v: unknown): v is Diagnostics {
  if (!isObj(v)) return false;
  const rungOk =
    v["rung"] === "pre-boot" || v["rung"] === "post-boot" || v["rung"] === "css-only";
  return (
    rungOk &&
    (v["pluginApiVersion"] === null || typeof v["pluginApiVersion"] === "string") &&
    typeof v["bootMs"] === "number" &&
    Array.isArray(v["modules"]) &&
    v["modules"].every(isModuleRecord) &&
    Array.isArray(v["notes"]) &&
    v["notes"].every((n) => typeof n === "string")
  );
}

/**
 * A path on this origin, and nothing else — the one thing `nav:route` may
 * carry. Checked on both ends: by the ISOLATED sender before it posts, and by
 * MAIN before the router sees it, because MAIN cannot tell the palette's port
 * from a page script's.
 *
 * "Starts with a slash" is not enough on its own. `//evil.example` is a
 * protocol-relative URL that the router would hand to `location`, and Chrome
 * reads `/\evil.example` the same way, so the second character is what the
 * check is really about. Nor is the second character enough: the URL parser
 * strips ASCII tab, LF and CR before it looks, so `/\n/evil.example` passed
 * the slash test and reached the `location.assign` fallbacks (bridge/main.ts,
 * command-palette.ts) as `//evil.example`. Every C0 control, the space and DEL
 * are refused outright — a path the palette builds is percent-encoded and
 * never carries one — and then the string is parsed against a placeholder
 * origin and must still be on it, so whatever else the parser does with a
 * shape not thought of here, the answer cannot name another host.
 * Discourse's own `DiscourseURL.isInternal` covers this too; the cap keeps a
 * hostile message from being a megabyte of slash.
 */
const PLACEHOLDER_ORIGIN = "https://dfp.invalid";

/** C0 controls, the space and DEL — the characters a URL parser strips or trims. */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function isRoutePath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return false;
  if (!/^\/(?![/\\])/.test(v) || hasControlOrSpace(v)) return false;
  try {
    return new URL(v, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
}

export function isInbound(v: unknown): v is Inbound {
  if (!isObj(v)) return false;
  if (typeof v["id"] === "number") return typeof v["ok"] === "boolean";
  switch (v["t"]) {
    case "settings:changed":
      return isObj(v["settings"]);
    case "nav:route":
      return isRoutePath(v["href"]);
    default:
      return false;
  }
}
