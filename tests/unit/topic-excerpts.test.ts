import { ModuleRegistry, type ModuleRecord } from "../../src/core/registry";
import { EXPAND_PINNED, topicExcerpts } from "../../src/discourse/modules/topic-excerpts";
import type { PluginApi, ValueTransformerArgs } from "../../src/discourse/types";

/**
 * The excerpts module is one registration, so what there is to hold is its
 * contract with the registry: the name it registers under, the answer it
 * gives, the root attribute it stamps, and what happens when a `-dev`
 * Discourse no longer knows the name. Discourse refuses an unknown name two
 * ways — a throw under its test environment, a console.warn plus `return
 * false` on a production build — and both must read as `failed` in the popup:
 * the module does not catch the throw, and it turns the false into one.
 * Either swallowed would read "installed" over a list with no excerpts on it,
 * and this is where that regression would show.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

type Transformer = (args: ValueTransformerArgs<boolean>) => boolean;

/** Just enough <html> for `install` to stamp — fresh per case, so a stamp cannot leak between them. */
function freshRoot(): Map<string, string> {
  const attrs = new Map<string, string>();
  (globalThis as Record<string, unknown>)["document"] = {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
    },
  };
  return attrs;
}

/**
 * A plugin API that records registrations, or refuses them one of the two ways
 * Discourse's `_registerTransformer` does for an unknown name: `"throw"` is its
 * test-environment path, `"false"` the production one (warn, store nothing,
 * return false). A registration that goes through answers true, as the real
 * method does.
 */
function fakeApi(refuse?: "throw" | "false") {
  const registered: { name: string; fn: Transformer }[] = [];
  const api = {
    registerValueTransformer: (name: string, fn: Transformer) => {
      if (refuse === "throw") {
        throw new Error(
          `api.registerValueTransformer: transformer "${name}" is unknown and it cannot be registered.`,
        );
      }
      if (refuse === "false") return false;
      registered.push({ name, fn });
      return true;
    },
  } as unknown as PluginApi;
  return { api, registered };
}

function registryFor(enabled: boolean) {
  const records: ModuleRecord[] = [];
  const registry = new ModuleRegistry({
    strikes: {},
    isEnabled: () => enabled,
    onStrike: () => {},
    onRecord: (r) => records.push(r),
  });
  return { registry, records };
}

console.log("── the registration ──────────────────────────────────────────────");
{
  freshRoot();
  const { api, registered } = fakeApi();
  topicExcerpts(api).install();

  eq(registered.length, 1, "one transformer, nothing else");
  eq(registered[0]?.name, EXPAND_PINNED, "registered under Discourse's expand-pinned name");
  eq(EXPAND_PINNED, "topic-list-item-expand-pinned", "…which is the name the list item reads");

  const fn = registered[0]!.fn;
  eq(fn({ value: false, context: { topic: { pinned: false } } }), true, "an ordinary row expands");
  eq(fn({ value: true, context: { topic: { pinned: true } } }), true, "a pinned row still expands");
  eq(fn({ value: false, context: {} }), true, "no topic in the context is not a reason to say no");
}

console.log("\n── through the registry ──────────────────────────────────────────");
{
  const attrs = freshRoot();
  const { api } = fakeApi();
  const { registry, records } = registryFor(true);
  registry.install(topicExcerpts(api));

  eq(records[0]?.status, "installed", "installs");
  eq(records[0]?.id, "topic-excerpts", "under its own id");
  eq(attrs.get("data-dfp-excerpts"), "1", "stamps data-dfp-excerpts on <html> for the stylesheet");
}

console.log("\n── an unknown transformer name: the throw ────────────────────────");
{
  const attrs = freshRoot();
  const { api } = fakeApi("throw");
  const { registry, records } = registryFor(true);
  registry.install(topicExcerpts(api));

  eq(records[0]?.status, "failed", "the throw reaches the registry and reads as failed, not installed");
  check(
    (records[0]?.error ?? "").includes("unknown"),
    `…with Discourse's message on the record  →  ${JSON.stringify(records[0]?.error)}`,
  );
  eq(attrs.has("data-dfp-excerpts"), false, "and no attribute claims excerpts that will not render");
}

console.log("\n── an unknown transformer name: the false ────────────────────────");
{
  const attrs = freshRoot();
  const { api, registered } = fakeApi("false");
  const { registry, records } = registryFor(true);
  registry.install(topicExcerpts(api));

  eq(records[0]?.status, "failed", "a returned false reads as failed too — the production path");
  check(
    (records[0]?.error ?? "").includes(EXPAND_PINNED),
    `…naming the transformer that was refused  →  ${JSON.stringify(records[0]?.error)}`,
  );
  eq(registered.length, 0, "nothing was stored on Discourse's side");
  eq(attrs.has("data-dfp-excerpts"), false, "and nothing is stamped over a list that will not change");
}

console.log("\n── switched off ──────────────────────────────────────────────────");
{
  const attrs = freshRoot();
  const { api, registered } = fakeApi();
  const { registry, records } = registryFor(false);
  registry.install(topicExcerpts(api));

  eq(records[0]?.status, "disabled-by-user", "the registry never calls install()");
  eq(registered.length, 0, "so nothing is registered");
  eq(attrs.size, 0, "and nothing is stamped");
}

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
