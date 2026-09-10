import {
  HANDSHAKE_TYPE,
  isDiagnostics,
  isMainReady,
  isRequest,
  isRoutePath,
  type Diagnostics,
  type Push,
  type Request,
  type Response,
} from "./protocol";
import { getSettings, onSettingsChanged } from "../settings";
import type { DfpSettings, ModuleId } from "../settings-schema";

const STRIKES_KEY = "moduleStrikes";
const DIAG_KEY = "diagnostics";

/**
 * How long a storage.local diagnostics entry stays believable.
 *
 * storage.session is the right home — diagnostics describe one page load and
 * should die with the tab — but Firefox content scripts cannot reach it (see
 * background.ts), so there the entry goes to storage.local, which outlives
 * everything. The popup would otherwise present last week's page load as the
 * current one. Ten minutes covers "open the popup after a slow page" without
 * covering "the next day".
 */
const DIAG_LOCAL_TTL_MS = 10 * 60_000;

/**
 * Serialises the strike read-modify-writes.
 *
 * `handle` is async, so two `strikes:bump` requests in flight together — two
 * watchers striking in the same frame do exactly that — both read the same
 * counter, both add one, and the second write overwrites the first. A clear
 * racing a bump loses the same way. Chaining every write through one promise
 * makes the second read see the first write; the chain swallows its own
 * rejections so one failed write cannot wedge every write after it.
 */
let strikeWrites: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = strikeWrites.then(fn, fn);
  strikeWrites = next.catch(() => {});
  return next;
}

export interface IsolatedBridgeHandlers {
  onDiagnostics?: (d: Diagnostics) => void;
}

/**
 * ISOLATED-world half of the bridge — the only side with chrome.* access.
 *
 * Everything arriving here is treated as untrusted input (see protocol.ts for
 * why). `isRequest` gates the switch, so a malformed or hostile message is
 * dropped before it can reach storage.
 */
export class IsolatedBridge {
  private readonly channel = new MessageChannel();
  private readonly nonce = crypto.randomUUID();
  private offered = false;
  /**
   * True once MAIN has sent anything at all over the port. The offer is
   * one-way — a transferred port reports nothing about whether the other end
   * took it — but MAIN sends a request on every rung of the boot ladder
   * (`settings:get` once the plugin API is up, `diag:push` on css-only), so the
   * first validated request is the proof that something is listening.
   */
  private connected = false;

  constructor(private readonly handlers: IsolatedBridgeHandlers = {}) {
    this.channel.port1.onmessage = this.onRequest;
    this.channel.port1.start();

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      if (isMainReady(event.data)) this.offer();
    });

    // Offer immediately in case MAIN is already listening; the re-offer above
    // covers the reverse ordering. MAIN closes duplicates.
    this.offer();

    onSettingsChanged((settings) => this.push({ t: "settings:changed", settings }));
  }

  private offer(): void {
    // The port can only be transferred once, so a second offer would throw.
    if (this.offered) return;
    this.offered = true;
    window.postMessage({ type: HANDSHAKE_TYPE, nonce: this.nonce }, window.location.origin, [
      this.channel.port2,
    ]);
  }

  private push(message: Push): void {
    this.channel.port1.postMessage(message);
  }

  private reply(res: Response): void {
    this.channel.port1.postMessage(res);
  }

  /**
   * Ask MAIN to navigate in-app. Returns false when it did not ask — nobody has
   * ever spoken from the other end, or the path is not a same-origin one — so
   * the caller can fall back to a document load itself.
   *
   * The alternative, sending blind and watching `location.pathname` for a
   * change, was rejected: a search from the search page and a jump to the page
   * already open both leave the path as it is, and either would have been
   * loaded twice.
   */
  route(href: string): boolean {
    if (!this.connected || !isRoutePath(href)) return false;
    this.push({ t: "nav:route", href });
    return true;
  }

  private onRequest = (event: MessageEvent): void => {
    const req: unknown = event.data;
    if (!isRequest(req)) return;
    this.connected = true;
    void this.handle(req);
  };

  private async handle(req: Request): Promise<void> {
    try {
      switch (req.t) {
        case "settings:get": {
          const settings: DfpSettings = await getSettings();
          this.reply({ id: req.id, ok: true, data: settings });
          return;
        }
        case "strikes:get": {
          this.reply({ id: req.id, ok: true, data: await readStrikes() });
          return;
        }
        case "strikes:bump": {
          const strikes = await serialized(async () => {
            const current = await readStrikes();
            current[req.module] = (current[req.module] ?? 0) + 1;
            await chrome.storage.local.set({ [STRIKES_KEY]: current });
            return current;
          });
          this.reply({ id: req.id, ok: true, data: strikes });
          return;
        }
        case "strikes:clear": {
          /* The counter is meant to be CONSECUTIVE failures — registry.ts says
           * "three routes running" — but nothing ever decremented it, so three
           * slow loads spread over a month latched a module off for good. A
           * route the module finishes under budget now clears the record. */
          const strikes = await serialized(async () => {
            const current = await readStrikes();
            if (current[req.module]) {
              delete current[req.module];
              await chrome.storage.local.set({ [STRIKES_KEY]: current });
            }
            return current;
          });
          this.reply({ id: req.id, ok: true, data: strikes });
          return;
        }
        case "diag:push": {
          /* The handler runs before storage is touched, and the reply does not
           * depend on storage at all.
           *
           * It was the other way round: `await storage.session.set` first, then
           * the handler, inside this one try. On Firefox the set throws — its
           * content scripts cannot use storage.session — so the catch below
           * replied an error and the handler never ran: `latestDiagnostics` in
           * isolated.content.ts stayed null, the overlay's module rows stayed
           * empty and the popup said "No data" on every page, forever. The
           * same ordering bit Chromium whenever a push landed before the
           * worker's setAccessLevel had run. */
          this.handlers.onDiagnostics?.(req.diagnostics);
          await storeDiagnostics(req.diagnostics);
          this.reply({ id: req.id, ok: true, data: null });
          return;
        }
      }
    } catch (err) {
      this.reply({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/* Exported for the options page, which shows per-module strike state so an
 * auto-disabled module is visible rather than silently missing. */
export async function readStrikes(): Promise<Partial<Record<ModuleId, number>>> {
  try {
    const stored = await chrome.storage.local.get(STRIKES_KEY);
    const raw = stored[STRIKES_KEY];
    if (typeof raw !== "object" || raw === null) return {};
    const out: Partial<Record<ModuleId, number>> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k as ModuleId] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * storage.session when it can be reached, storage.local otherwise.
 *
 * Session-scoped is the intent: diagnostics describe this page load only and
 * should not outlive the tab. The local fallback carries a timestamp so the
 * reader can refuse a stale one (`DIAG_LOCAL_TTL_MS`). Never throws — the
 * handler that matters has already run by the time this is called, and a
 * storage failure is not a reason to fail the request.
 */
async function storeDiagnostics(diagnostics: Diagnostics): Promise<void> {
  try {
    await chrome.storage.session.set({ [DIAG_KEY]: diagnostics });
    return;
  } catch {
    // Fall through to local.
  }
  try {
    await chrome.storage.local.set({ [DIAG_KEY]: { at: Date.now(), diagnostics } });
  } catch {
    // Neither area is reachable; the in-page handler still saw the push.
  }
}

/**
 * Session first, then the timestamped local fallback. Both reads are guarded
 * separately: the popup is an extension page and can read storage.session on
 * either browser, but on Firefox nothing was ever written there.
 */
export async function readDiagnostics(): Promise<Diagnostics | null> {
  try {
    const stored = await chrome.storage.session.get(DIAG_KEY);
    const fromSession = stored[DIAG_KEY];
    if (isDiagnostics(fromSession)) return fromSession;
  } catch {
    // Not reachable from here; try local.
  }
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const entry = stored[DIAG_KEY] as { at?: unknown; diagnostics?: unknown } | undefined;
    if (
      entry &&
      typeof entry.at === "number" &&
      Date.now() - entry.at <= DIAG_LOCAL_TTL_MS &&
      isDiagnostics(entry.diagnostics)
    ) {
      return entry.diagnostics;
    }
  } catch {
    // Nothing readable anywhere.
  }
  return null;
}

export async function clearStrikes(): Promise<void> {
  await chrome.storage.local.remove(STRIKES_KEY);
}
