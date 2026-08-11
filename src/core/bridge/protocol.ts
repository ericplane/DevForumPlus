import type { DfpSettings, ModuleId } from "../settings-schema";
import { MODULE_IDS } from "../settings-schema";
import type { ModuleRecord } from "../registry";

/**
 * Wire protocol between the MAIN and ISOLATED content scripts.
 *
 * ── Threat model ────────────────────────────────────────────────────────────
 * The handshake uses `window.postMessage`, and every listener on that window —
 * including page scripts — receives the event and could take the transferred
 * port. We accept that, deliberately, for two reasons:
 *
 *   1. The bridge surface is intentionally boring: read settings, read/bump
 *      strike counters, push diagnostics. There is no privileged capability on
 *      the other end to steal. The ISOLATED side re-validates every inbound
 *      message and never passes MAIN-supplied data into a chrome.* call
 *      unchecked.
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
  /* Cleared when a module installs under budget — see registry.ts. */
  | { id: number; t: "strikes:clear"; module: ModuleId }
  | { id: number; t: "diag:push"; diagnostics: Diagnostics };

export type Response =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

export type Push = { t: "settings:changed"; settings: DfpSettings };

export type Inbound = Response | Push;

// ── Validators ──────────────────────────────────────────────────────────────
// Hand-rolled rather than pulled from a schema library: this code ships inside
// a content script that runs at document_start on every page load, and eight
// message shapes do not justify the bytes.

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isModuleId = (v: unknown): v is ModuleId =>
  typeof v === "string" && (MODULE_IDS as readonly string[]).includes(v);

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

function isDiagnostics(v: unknown): v is Diagnostics {
  if (!isObj(v)) return false;
  const rungOk =
    v["rung"] === "pre-boot" || v["rung"] === "post-boot" || v["rung"] === "css-only";
  return (
    rungOk &&
    (v["pluginApiVersion"] === null || typeof v["pluginApiVersion"] === "string") &&
    typeof v["bootMs"] === "number" &&
    Array.isArray(v["modules"]) &&
    Array.isArray(v["notes"])
  );
}

export function isInbound(v: unknown): v is Inbound {
  if (!isObj(v)) return false;
  if (typeof v["id"] === "number") return typeof v["ok"] === "boolean";
  return v["t"] === "settings:changed" && isObj(v["settings"]);
}
