import {
  MAIN_READY_TYPE,
  isHandshake,
  isInbound,
  type Diagnostics,
  type Request,
} from "./protocol";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type DfpSettings,
  type ModuleId,
} from "../settings-schema";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * `Omit` over a union collapses it to the keys all members share, which would
 * silently drop `module` and `diagnostics` from the request type. Distributing
 * over the union first keeps each variant intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type OutgoingRequest = DistributiveOmit<Request, "id">;

/**
 * MAIN-world half of the bridge.
 *
 * Ordering between two content scripts injected into different worlds at the
 * same `run_at` is not guaranteed, so neither side may assume it went first.
 * Both are idempotent: MAIN announces itself *and* listens, ISOLATED offers a
 * port immediately *and* re-offers whenever it sees MAIN's announcement. The
 * first port to arrive wins; later ones are closed.
 */
export class MainBridge {
  private port: MessagePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Request[] = [];
  private settingsListeners: ((s: DfpSettings) => void)[] = [];

  constructor() {
    window.addEventListener("message", this.onWindowMessage, true);
    // Announce, in case ISOLATED is already up and waiting.
    window.postMessage({ type: MAIN_READY_TYPE }, window.location.origin);
  }

  private onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!isHandshake(event.data)) return;

    const offered = event.ports[0];
    if (!offered) return;

    if (this.port) {
      // Already bridged. Decline politely rather than swapping mid-flight.
      offered.close();
      return;
    }

    this.port = offered;
    this.port.onmessage = this.onPortMessage;
    this.port.start();

    // Anything requested before the bridge came up goes out now, in order.
    for (const req of this.queue.splice(0)) this.port.postMessage(req);
  };

  private onPortMessage = (event: MessageEvent): void => {
    const msg = event.data;
    if (!isInbound(msg)) return;

    if ("t" in msg && msg.t === "settings:changed") {
      const settings = normalizeSettings(msg.settings);
      for (const fn of this.settingsListeners) fn(settings);
      return;
    }

    if (!("id" in msg)) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error));
  };

  private send(req: OutgoingRequest): Promise<unknown> {
    const id = this.nextId++;
    const full = { ...req, id } as Request;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.port) this.port.postMessage(full);
      else this.queue.push(full);

      // The bridge is local; if it has not answered in 5s it is not going to.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`dfp: bridge timeout (${full.t})`));
      }, 5000);
    });
  }

  async getSettings(): Promise<DfpSettings> {
    try {
      return normalizeSettings(await this.send({ t: "settings:get" }));
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async getStrikes(): Promise<Partial<Record<ModuleId, number>>> {
    try {
      const data = await this.send({ t: "strikes:get" });
      return typeof data === "object" && data !== null
        ? (data as Partial<Record<ModuleId, number>>)
        : {};
    } catch {
      return {};
    }
  }

  clearStrike(module: ModuleId): void {
    this.send({ t: "strikes:clear", module });
  }

  bumpStrike(module: ModuleId, ms: number): void {
    void this.send({ t: "strikes:bump", module, ms }).catch(() => {});
  }

  pushDiagnostics(diagnostics: Diagnostics): void {
    void this.send({ t: "diag:push", diagnostics }).catch(() => {});
  }

  onSettingsChanged(fn: (s: DfpSettings) => void): void {
    this.settingsListeners.push(fn);
  }
}
