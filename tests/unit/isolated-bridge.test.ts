/**
 * The ISOLATED bridge's request handler, driven through a real MessageChannel
 * against a chrome stub.
 *
 * Two orderings live here that nothing else can see:
 *
 *   1. `diag:push` must hand the diagnostics to the in-page handler BEFORE it
 *      touches storage. It used to `await chrome.storage.session.set` first,
 *      inside the same try as the handler call — and on Firefox that set
 *      throws (its content scripts cannot use storage.session), so the handler
 *      never ran: the popup said "No data" on every page and the overlay's
 *      module rows stayed empty, forever, with no error anywhere.
 *
 *   2. `strikes:bump` and `strikes:clear` are read-modify-writes on one key.
 *      Two watchers striking in the same frame send two bumps that were both
 *      in flight at once; both read the same counter and the second write
 *      overwrote the first. The count was one, not two.
 *
 * The stubs are the smallest thing the constructor and these handlers touch:
 * a `window` that hands back the offered port, and a `chrome.storage` whose
 * areas can be made to throw or to yield between read and write.
 */

import type { Diagnostics, Response } from "../../src/core/bridge/protocol";

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};

// ── Stubs ───────────────────────────────────────────────────────────────────

type Store = Record<string, unknown>;

interface AreaOptions {
  /** Every call throws, the way storage.session does from a Firefox content script. */
  unavailable?: boolean;
  /** Yield between calls, so two handlers can genuinely interleave. */
  slow?: boolean;
}

/* One chronological log shared by every storage area AND the diagnostics
 * handler, because the assertion that matters is which of them ran first. A
 * per-area log concatenated with the handler's cannot tell — it once let a
 * mutant with the old storage-first ordering pass. */
const timeline: string[] = [];

function area(name: string, opts: AreaOptions = {}) {
  const data: Store = {};
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    data,
    async get(key: string): Promise<Store> {
      if (opts.unavailable) throw new Error("storage area unavailable");
      if (opts.slow) await tick();
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items: Store): Promise<void> {
      timeline.push(`${name}.set:${Object.keys(items).join(",")}`);
      if (opts.unavailable) throw new Error("storage area unavailable");
      if (opts.slow) await tick();
      Object.assign(data, items);
    },
    async remove(key: string): Promise<void> {
      delete data[key];
    },
  };
}

let session = area("session");
let local = area("local");
let offered: MessagePort | null = null;

const g = globalThis as Record<string, unknown>;
g["chrome"] = {
  storage: {
    get session() {
      return session;
    },
    get local() {
      return local;
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};
g["window"] = {
  location: { origin: "https://devforum.roblox.com" },
  addEventListener() {},
  postMessage(_msg: unknown, _origin: string, transfer?: MessagePort[]) {
    offered = transfer?.[0] ?? null;
  },
};

/* Imported after the stubs exist. Neither module runs anything at import time,
 * but the constructor below reads `window` and `chrome` immediately. */
const { IsolatedBridge, readDiagnostics } = await import("../../src/core/bridge/isolated");

const diagnostics: Diagnostics = {
  rung: "pre-boot",
  pluginApiVersion: "2.1.1",
  bootMs: 40,
  modules: [
    { id: "code-intel", status: "installed", installMs: 0.1, workMs: 7.2, budgetMs: 100, strikes: 0 },
  ],
  notes: [],
};

/** A bridge whose MAIN-side port we hold. Its handler writes to `timeline` like the storage stubs. */
function bridge() {
  offered = null;
  timeline.length = 0;
  const instance = new IsolatedBridge({
    onDiagnostics: () => timeline.push("handler"),
  });
  const port = offered as MessagePort | null;
  if (!port) throw new Error("the bridge offered no port");
  port.start();
  let nextId = 1;
  const send = (req: Record<string, unknown>): Promise<Response> =>
    new Promise((resolve) => {
      const id = nextId++;
      const onMessage = (ev: MessageEvent) => {
        const res = ev.data as Response;
        if (res.id !== id) return;
        port.removeEventListener("message", onMessage as EventListener);
        resolve(res);
      };
      port.addEventListener("message", onMessage as EventListener);
      port.postMessage({ ...req, id });
    });
  /** The next unsolicited message MAIN's end would see, by verb. */
  const nextPush = (t: string): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        const msg = ev.data as Record<string, unknown>;
        if (msg["t"] !== t) return;
        port.removeEventListener("message", onMessage as EventListener);
        resolve(msg);
      };
      port.addEventListener("message", onMessage as EventListener);
    });
  return { send, port, instance, nextPush };
}

console.log("── diag:push reaches the handler even when storage.session throws ────");

{
  session = area("session", { unavailable: true });
  local = area("local");
  const b = bridge();
  const res = await b.send({ t: "diag:push", diagnostics });

  check(timeline.includes("handler"), "the handler ran");
  check(res.ok, "the reply is ok:true — a storage failure is not a request failure");
  check(
    timeline[0] === "handler" && timeline.length === 3,
    `the handler ran BEFORE storage was touched (${timeline.join(" → ")})`,
  );
  const stored = local.data["diagnostics"] as { at?: unknown; diagnostics?: unknown } | undefined;
  check(typeof stored?.at === "number", "the local fallback is timestamped");
  check(
    JSON.stringify(stored?.diagnostics) === JSON.stringify(diagnostics),
    "the local fallback holds the diagnostics that were pushed",
  );
  b.port.close();
}

{
  session = area("session");
  local = area("local");
  const b = bridge();
  const res = await b.send({ t: "diag:push", diagnostics });
  check(res.ok && timeline[0] === "handler", "with session available the handler still runs first");
  check(session.data["diagnostics"] !== undefined, "…and session is the home");
  check(!timeline.some((e) => e.startsWith("local.")), "…and local is not written at all");
  b.port.close();
}

{
  session = area("session", { unavailable: true });
  local = area("local", { unavailable: true });
  const b = bridge();
  const res = await b.send({ t: "diag:push", diagnostics });
  check(res.ok && timeline.includes("handler"), "with no storage at all the in-page handler is still served");
  b.port.close();
}

console.log("\n── readDiagnostics: session first, then a local entry that is not stale ──");

{
  session = area("session", { unavailable: true });
  local = area("local");
  local.data["diagnostics"] = { at: Date.now() - 60_000, diagnostics };
  const d = await readDiagnostics();
  check(d !== null && d.rung === "pre-boot", "a minute-old local entry is served when session is unreachable");

  local.data["diagnostics"] = { at: Date.now() - 11 * 60_000, diagnostics };
  check((await readDiagnostics()) === null, "an eleven-minute-old local entry is not");

  local.data["diagnostics"] = { at: Date.now(), diagnostics: { ...diagnostics, modules: [{ id: "code-intel" }] } };
  check((await readDiagnostics()) === null, "a local entry of an older shape is not");

  session = area("session");
  session.data["diagnostics"] = { ...diagnostics, rung: "post-boot" };
  local.data["diagnostics"] = { at: Date.now(), diagnostics };
  const fromSession = await readDiagnostics();
  check(fromSession?.rung === "post-boot", "session wins over local when both are readable");
}

console.log("\n── strike writes are serialised ──────────────────────────────────────");

{
  session = area("session");
  local = area("local", { slow: true });
  const b = bridge();
  // Both in flight at once, as two watchers striking in one frame would be.
  const [r1, r2] = await Promise.all([
    b.send({ t: "strikes:bump", module: "code-intel", ms: 60 }),
    b.send({ t: "strikes:bump", module: "code-intel", ms: 61 }),
  ]);
  const strikes = local.data["moduleStrikes"] as Record<string, number>;
  check(r1.ok && r2.ok, "both bumps are acknowledged");
  check(strikes["code-intel"] === 2, "two concurrent bumps count two, not one");

  const [r3, r4] = await Promise.all([
    b.send({ t: "strikes:bump", module: "facepile", ms: 20 }),
    b.send({ t: "strikes:clear", module: "facepile" }),
  ]);
  const after = local.data["moduleStrikes"] as Record<string, number>;
  check(r3.ok && r4.ok, "a bump and a clear in flight together are both acknowledged");
  check(after["facepile"] === undefined, "…and the clear, sent second, is what stands");
  check(after["code-intel"] === 2, "…without disturbing another module's count");
  b.port.close();
}

/* The palette's navigation. A transferred port says nothing about whether
 * anyone took it, so `route()` declines until MAIN has sent a request — the
 * one thing MAIN does on every rung of the boot ladder — and the palette loads
 * the document itself. Once MAIN has spoken, the path goes out as `nav:route`,
 * and only a same-origin path does. */
console.log("\n── route(): declined until MAIN has spoken, then a push ──────────────");

{
  session = area("session");
  local = area("local");
  const b = bridge();
  let heard = 0;
  b.port.addEventListener("message", ((ev: MessageEvent) => {
    if ((ev.data as { t?: unknown }).t === "nav:route") heard++;
  }) as EventListener);

  check(b.instance.route("/latest") === false, "before any request, route() declines");
  await new Promise((r) => setTimeout(r, 0));
  check(heard === 0, "…and nothing was sent");

  await b.send({ t: "strikes:get" });
  const push = b.nextPush("nav:route");
  check(b.instance.route("/t/some-slug/4301387") === true, "after a request, route() sends");
  const msg = await push;
  check(msg["href"] === "/t/some-slug/4301387", `…and the push carries the path (${JSON.stringify(msg)})`);

  check(b.instance.route("https://evil.example/") === false, "an absolute URL is refused at the sender");
  check(b.instance.route("//evil.example") === false, "…so is a protocol-relative one");
  await new Promise((r) => setTimeout(r, 0));
  check(heard === 1, "…and neither reached the port");
  b.port.close();
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
