import {
  HANDSHAKE_TYPE,
  isMainReady,
  isRequest,
  type Diagnostics,
  type Push,
  type Request,
  type Response,
} from "./protocol";
import { getSettings, onSettingsChanged } from "../settings";
import type { DfpSettings, ModuleId } from "../settings-schema";

const STRIKES_KEY = "moduleStrikes";
const DIAG_KEY = "diagnostics";

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

  private onRequest = (event: MessageEvent): void => {
    const req: unknown = event.data;
    if (!isRequest(req)) return;
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
          const strikes = await readStrikes();
          strikes[req.module] = (strikes[req.module] ?? 0) + 1;
          await chrome.storage.local.set({ [STRIKES_KEY]: strikes });
          this.reply({ id: req.id, ok: true, data: strikes });
          return;
        }
        case "strikes:clear": {
          /* The counter is meant to be CONSECUTIVE failures — registry.ts says
           * "three loads running" — but nothing ever decremented it, so three
           * slow loads spread over a month latched a module off for good. A
           * clean install now clears the record. */
          const strikes = await readStrikes();
          if (strikes[req.module]) {
            delete strikes[req.module];
            await chrome.storage.local.set({ [STRIKES_KEY]: strikes });
          }
          this.reply({ id: req.id, ok: true, data: strikes });
          return;
        }
        case "diag:push": {
          // Session-scoped: diagnostics describe this page load only, and we do
          // not want them outliving the tab.
          await chrome.storage.session.set({ [DIAG_KEY]: req.diagnostics });
          this.handlers.onDiagnostics?.(req.diagnostics);
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

export async function readDiagnostics(): Promise<Diagnostics | null> {
  try {
    const stored = await chrome.storage.session.get(DIAG_KEY);
    return (stored[DIAG_KEY] as Diagnostics | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function clearStrikes(): Promise<void> {
  await chrome.storage.local.remove(STRIKES_KEY);
}
