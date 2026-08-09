/**
 * Compile Roblox's Creator Docs into shards the extension can serve offline.
 *
 * Source is the `Roblox/creator-docs` repo — the same YAML that
 * create.roblox.com renders. Its `reference/engine` tree is ~9.5 MB across 1243
 * files, which settles the architecture on its own: this cannot be a constant
 * in a content-script bundle. It ships as per-owner JSON shards under
 * `public/docs/`, and exactly one shard is read when a card actually opens.
 *
 * What is kept, and what is thrown away, is the whole job here:
 *
 *   kept     name, kind, parameter names + types + defaults, return types,
 *            the one-line summary, and the flags a reader acts on (deprecated,
 *            yields, security).
 *   dropped  `description` (paragraphs of prose — a card is not a docs page,
 *            and this is ~70% of the bytes), `code_samples`, `memory_category`,
 *            `thread_safety`, and every cross-reference body.
 *
 * The card links out to create.roblox.com for the full page, so the bar for
 * including a field is "a reader decides something differently because of it".
 *
 * Runs at build time, never on the user's machine. Nothing here touches the
 * network at runtime — the feature works offline and makes no request that
 * could report what someone is reading.
 *
 * Run: npm run docs-index
 */

import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const TARBALL =
  "https://codeload.github.com/Roblox/creator-docs/tar.gz/refs/heads/main";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cacheTar = resolve(root, "node_modules/.cache/creator-docs.tar.gz");
const cacheDir = resolve(root, "node_modules/.cache/creator-docs");
const outDir = resolve(root, "public/docs");
const namesOut = resolve(root, "src/luau/docs-names.generated.ts");

/* Kind codes. Numbers rather than strings because they repeat once per member
 * across ~17k members, and the card maps them back to labels. */
const KIND = {
  property: 0,
  method: 1,
  event: 2,
  callback: 3,
  function: 4,
  constructor: 5,
  constant: 6,
  mathop: 7,
} as const;

/* Flag bits, same reasoning. */
const F_DEPRECATED = 1;
const F_YIELDS = 2;
const F_SECURITY = 4; // needs elevated security context; not callable from a normal script
const F_READONLY = 8;

interface RawMember {
  name?: string;
  summary?: string;
  /** Properties and constants carry their value type here, not in `returns`. */
  type?: string;
  parameters?: { name?: string; type?: string; default?: unknown }[];
  returns?: { type?: string }[];
  tags?: string[];
  deprecation_message?: string;
  security?: unknown;
}

interface RawDoc {
  name?: string;
  type?: string;
  summary?: string;
  inherits?: string[];
  tags?: string[];
  deprecation_message?: string;
  properties?: RawMember[];
  methods?: RawMember[];
  events?: RawMember[];
  callbacks?: RawMember[];
  functions?: RawMember[];
  constructors?: RawMember[];
  constants?: RawMember[];
  math_operations?: RawMember[];
  items?: { name?: string; value?: number; summary?: string }[];
}

function ensureSource(): string {
  if (existsSync(cacheDir)) {
    console.log("  docs-index: using cached checkout");
    return cacheDir;
  }
  if (!existsSync(cacheTar)) {
    console.log("  docs-index: downloading creator-docs…");
    mkdirSync(dirname(cacheTar), { recursive: true });
    execFileSync("curl", ["-sL", TARBALL, "-o", cacheTar]);
  }
  console.log("  docs-index: extracting…");
  mkdirSync(cacheDir, { recursive: true });
  execFileSync("tar", [
    "xzf",
    cacheTar,
    "-C",
    cacheDir,
    "--strip-components=1",
    "creator-docs-main/content/en-us/reference/engine",
  ]);
  return cacheDir;
}

/**
 * Turn docs markdown into something a plain-text card can show.
 *
 * The summaries are full markdown with Roblox's own cross-reference syntax:
 * `Class.GlobalDataStore:GetAsync()`, `Datatype.Vector3`, `Enum.KeyCode|KeyCode`.
 * Rendering that raw puts "Class." in front of half the nouns on the card, and
 * rendering it as HTML would mean putting docs-repo markup into the page —
 * so it is flattened to the name a reader would recognise.
 */
function plain(md: string | undefined, limit = 220): string {
  if (!md) return "";
  let s = md
    // `Class.Foo.Bar|Display` → Display, else the last path segment.
    .replace(/`(?:Class|Datatype|Enum|Library|Global)\.([^`|]+)\|([^`]+)`/g, "$2")
    .replace(/`(?:Class|Datatype|Enum|Library|Global)\.([^`]+)`/g, (_m, p: string) => {
      const parts = p.split(/[.:]/);
      return parts[parts.length - 1] ?? p;
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (s.length <= limit) return s;
  // Prefer a sentence boundary so the card never ends mid-clause.
  const cut = s.lastIndexOf(". ", limit);
  s = cut > limit * 0.5 ? s.slice(0, cut + 1) : s.slice(0, limit).trimEnd() + "…";
  return s;
}

/** `GlobalDataStore:GetAsync` / `Vector3.new` / `task.wait` → `GetAsync`. */
function shortName(full: string | undefined): string {
  if (!full) return "";
  const m = /[.:]([^.:]+)$/.exec(full);
  return m ? m[1]! : full;
}

function flagsOf(m: RawMember): number {
  const tags = (m.tags ?? []).map((t) => String(t).toLowerCase());
  let f = 0;
  if (tags.includes("deprecated") || (m.deprecation_message ?? "").trim()) f |= F_DEPRECATED;
  if (tags.includes("yields")) f |= F_YIELDS;
  if (tags.includes("readonly")) f |= F_READONLY;
  // `security` is either a string or {read,write}; anything but None is gated.
  const sec = m.security;
  const secStr =
    typeof sec === "string"
      ? sec
      : sec && typeof sec === "object"
        ? Object.values(sec as Record<string, unknown>).join(" ")
        : "";
  if (secStr && !/^\s*(None\s*)+$/i.test(secStr)) f |= F_SECURITY;
  return f;
}

/** One member, packed positionally. Trailing empties are trimmed by the caller. */
type PackedMember = [
  kind: number,
  params: [string, string, string?][],
  returns: string[],
  summary: string,
  flags: number,
];

function packMember(m: RawMember, kind: number): [string, PackedMember] | null {
  const name = shortName(m.name);
  if (!name) return null;
  const params = (m.parameters ?? []).map((p) => {
    const d = p.default;
    const def = d === undefined || d === null || d === "" ? undefined : String(d);
    return def !== undefined
      ? ([p.name ?? "", p.type ?? "any", def] as [string, string, string])
      : ([p.name ?? "", p.type ?? "any"] as unknown as [string, string, string?]);
  });
  /* Properties and constants have no `returns`; their value type is a
   * top-level `type`. Folding it into the same slot lets the card render
   * `Anchored: boolean` without a second shape to reason about. */
  const returns =
    kind === KIND.property || kind === KIND.constant
      ? m.type
        ? [m.type]
        : []
      : (m.returns ?? [])
          .map((r) => r.type ?? "any")
          // `void` and `()` both mean "returns nothing" — neither belongs on a
          // signature line.
          .filter((t) => t !== "void" && t !== "()");
  return [name, [kind, params, returns, plain(m.summary), flagsOf(m)]];
}

interface Shard {
  /** Owner summary. */
  s: string;
  /** Superclass, for the card's "inherited from" line. */
  i?: string;
  /** Owner-level flags (deprecated class). */
  f?: number;
  /** Members by short name. */
  m: Record<string, PackedMember>;
}

const MEMBER_KEYS: [keyof RawDoc, number][] = [
  ["properties", KIND.property],
  ["methods", KIND.method],
  ["events", KIND.event],
  ["callbacks", KIND.callback],
  ["functions", KIND.function],
  ["constructors", KIND.constructor],
  ["constants", KIND.constant],
  ["math_operations", KIND.mathop],
];

function buildShard(doc: RawDoc): Shard {
  const shard: Shard = { s: plain(doc.summary), m: {} };
  const inherit = doc.inherits?.[0];
  if (inherit) shard.i = inherit;
  const tags = (doc.tags ?? []).map((t) => String(t).toLowerCase());
  if (tags.includes("deprecated") || (doc.deprecation_message ?? "").trim()) {
    shard.f = F_DEPRECATED;
  }

  for (const [key, kind] of MEMBER_KEYS) {
    const list = doc[key] as RawMember[] | undefined;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const packed = packMember(raw, kind);
      if (!packed) continue;
      // A name can appear as both a constant and a property (Vector3.zero).
      // First wins; constructors/constants are listed before properties above
      // only where that is the more useful framing.
      shard.m[packed[0]] ??= packed[1];
    }
  }

  // Enums carry `items` rather than members.
  if (Array.isArray(doc.items)) {
    for (const it of doc.items) {
      const name = shortName(it.name) || it.name;
      if (!name) continue;
      shard.m[name] ??= [KIND.constant, [], [], plain(it.summary, 140), 0];
    }
  }
  return shard;
}

/** Strip trailing empty slots so 17k members do not each carry `,"",0`. */
function trim(p: PackedMember): unknown[] {
  const a: unknown[] = [...p];
  while (a.length > 1) {
    const last = a[a.length - 1];
    const empty =
      last === 0 || last === "" || (Array.isArray(last) && last.length === 0);
    if (!empty) break;
    a.pop();
  }
  return a;
}

function writeShard(dir: string, name: string, shard: Shard): number {
  const out: Record<string, unknown> = { s: shard.s, m: {} };
  if (shard.i) out["i"] = shard.i;
  if (shard.f) out["f"] = shard.f;
  const m = out["m"] as Record<string, unknown>;
  for (const [k, v] of Object.entries(shard.m)) m[k] = trim(v);
  const json = JSON.stringify(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), json, "utf8");
  return json.length;
}

// ── Build ───────────────────────────────────────────────────────────────────

const src = ensureSource();
const engine = join(src, "content/en-us/reference/engine");

if (existsSync(outDir)) rmSync(outDir, { recursive: true });

/** Directory in the source → subdirectory in the output. */
const GROUPS: { from: string; to: string; label: string }[] = [
  { from: "classes", to: "c", label: "classes" },
  { from: "datatypes", to: "d", label: "datatypes" },
  { from: "libraries", to: "g", label: "libraries" },
  { from: "globals", to: "g", label: "globals" },
  { from: "enums", to: "e", label: "enums" },
];

const stats: Record<string, { files: number; bytes: number; members: number }> = {};
/** Names the runtime is allowed to request. Doubles as the path allow-list. */
const names: Record<string, string[]> = { c: [], d: [], g: [], e: [] };

/* Type propagation tables for the main world — see the emit block near the
 * bottom of this file for why these are kept separate from the shards. */
const memberTypes: Record<string, Record<string, string>> = {};
const eventParams: Record<string, Record<string, string[]>> = {};

/**
 * The bare globals — `print`, `pcall`, `tick`, `game`, `workspace`, `script`.
 *
 * These live in `globals/LuaGlobals.yaml` and `globals/RobloxGlobals.yaml`,
 * whose `name` fields are "Luau globals" and "Roblox globals" — not
 * identifiers, so they cannot be shard names. Their *members* are what a post
 * actually writes, and they are written bare with no namespace in front, so
 * they merge into one shard and get their own lookup set.
 */
const bareGlobals: Shard = { s: "Luau and Roblox globals", m: {} };
/** Which docs page each bare global lives on, so links land on the right one. */
const bareGlobalPage: Record<string, "LuaGlobals" | "RobloxGlobals"> = {};

for (const g of GROUPS) {
  const dir = join(engine, g.from);
  if (!existsSync(dir)) continue;
  const st = (stats[g.label] ??= { files: 0, bytes: 0, members: 0 });

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml")) continue;
    let doc: RawDoc;
    try {
      doc = parse(readFileSync(join(dir, file), "utf8")) as RawDoc;
    } catch (err) {
      console.warn(`  docs-index: skipped ${g.from}/${file}: ${(err as Error).message}`);
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    const shard = buildShard(doc);

    if (g.from === "globals") {
      const page = file.startsWith("Roblox") ? "RobloxGlobals" : "LuaGlobals";
      for (const [k, v] of Object.entries(shard.m)) {
        if (bareGlobals.m[k]) continue;
        bareGlobals.m[k] = v;
        bareGlobalPage[k] = page;
      }
      st.members += Object.keys(shard.m).length;
      continue;
    }

    const name = doc.name ?? basename(file, ".yaml");
    // The runtime builds a path from this name, so anything that is not a plain
    // identifier is refused here rather than sanitised at read time.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      console.warn(`  docs-index: skipped non-identifier name ${JSON.stringify(name)}`);
      continue;
    }

    /* Collect the two things the MAIN world needs to propagate a type without
     * guessing. Everything else about a member — summary, params, flags — stays
     * in the shard and is fetched only when a card opens.
     *
     * The filter to class-typed entries happens at emit time, once the full set
     * of known names exists. */
    if (g.to === "c") {
      for (const [member, packed] of Object.entries(shard.m)) {
        const [kind, params, returns] = packed;
        if (kind === KIND.event) {
          if (params.length) (eventParams[name] ??= {})[member] = params.map((p) => p[1]);
        } else if (returns.length === 1 && returns[0]) {
          (memberTypes[name] ??= {})[member] = returns[0];
        }
      }
    }

    st.bytes += writeShard(join(outDir, g.to), name, shard);
    st.files++;
    st.members += Object.keys(shard.m).length;
    names[g.to]!.push(name);
  }
}

/* One extra shard for the bare globals. `globals` is a safe identifier and
 * cannot collide with a library — there is no `globals` library. */
const bareBytes = writeShard(join(outDir, "g"), "globals", bareGlobals);
const bareNames = Object.keys(bareGlobals.m).sort();
(stats["globals"] ??= { files: 0, bytes: 0, members: 0 }).files = 1;
stats["globals"]!.bytes = bareBytes;

for (const k of Object.keys(names)) names[k]!.sort();

/**
 * A names-only index, fetched lazily by the isolated world.
 *
 * This exists because of a false-positive class the corpus exposed: a post that
 * writes `ReplicatedStorage.Assets` or `Workspace.Ignore` is naming a folder the
 * author made, not an engine member. The main world cannot tell — it would need
 * the member tables, and those are 40 kB gzipped, which would more than double a
 * bundle that runs at document_start on every page.
 *
 * So the main world only *links* what it can prove from the sets it already
 * carries, and marks member-level references as provisional. This file is what
 * the isolated world uses to confirm them, and it is fetched only on a page that
 * actually has one. Names and superclass links only — no signatures, no
 * summaries; those come from the per-owner shard when a card opens.
 */
const verify: Record<string, { i?: string; m: string }> = {};

/* MERGES, never overwrites. `Instance` is both a class and a datatype, and the
 * datatype file holds only `new` — letting it replace the class entry dropped
 * the superclass link and with it `Name`, `Parent` and `WaitForChild`, i.e. the
 * three most-written members on the forum. */
function addVerify(name: string, shard: { i?: string; m: Record<string, unknown> }): void {
  const members = Object.keys(shard.m);
  if (!members.length && !shard.i) return;
  const existing = verify[name];
  if (!existing) {
    verify[name] = shard.i ? { i: shard.i, m: members.join(" ") } : { m: members.join(" ") };
    return;
  }
  const merged = new Set([...existing.m.split(" ").filter(Boolean), ...members]);
  existing.m = [...merged].join(" ");
  existing.i ??= shard.i;
}

/* Enums are included. An earlier version skipped them, reasoning that
 * `Enum.X.Y` proves itself by shape — true, but the confirmation pass strips
 * anything it cannot find, so every `Enum.EasingStyle.Sine` on the forum lost
 * its link. And the shape is not actually proof: `part.Material.Foo` reaches
 * the same code path with a receiver that is an enum but a member that is not
 * an item. */
for (const [group, list] of Object.entries(names)) {
  for (const n of list) {
    addVerify(
      n,
      JSON.parse(readFileSync(join(outDir, group, `${n}.json`), "utf8")) as {
        i?: string;
        m: Record<string, unknown>;
      },
    );
  }
}
/* The bare-globals shard is deliberately absent from DOC_NAMESPACES — a
 * variable called `globals` must not linkify — so it is added here by hand. */
addVerify("globals", bareGlobals as unknown as { i?: string; m: Record<string, unknown> });
const verifyJson = JSON.stringify(verify);
writeFileSync(join(outDir, "members.json"), verifyJson, "utf8");

const studioVersion = existsSync(join(engine, "STUDIO_VERSION"))
  ? readFileSync(join(engine, "STUDIO_VERSION"), "utf8").trim()
  : "unknown";

/* The name lists ship in the bundle — small, and needed in two places: to
 * decide what to linkify, and to refuse a path built from anything else. */
const nameFile = `/* GENERATED by scripts/build-docs-index.ts — do not edit.
 *
 * Names that have a Creator Docs shard under public/docs/. Two jobs:
 *   1. decide whether a token in a post is worth linking at all;
 *   2. act as the allow-list for the shard path, so a name read out of page
 *      content can never become a path traversal into extension resources.
 *
 * Creator Docs at generation: ${studioVersion}
 */

export const DOC_CLASSES: ReadonlySet<string> = new Set(${JSON.stringify(names["c"])});
export const DOC_DATATYPES: ReadonlySet<string> = new Set(${JSON.stringify(names["d"])});
export const DOC_NAMESPACES: ReadonlySet<string> = new Set(${JSON.stringify(names["g"])});
export const DOC_ENUMS: ReadonlySet<string> = new Set(${JSON.stringify(names["e"])});

/** Bare globals — \`print\`, \`pcall\`, \`tick\`, \`game\`, \`workspace\`, \`script\`. */
export const DOC_BARE_GLOBALS: ReadonlySet<string> = new Set(${JSON.stringify(bareNames)});

/** Which of the two globals pages each one documents. */
export const DOC_GLOBAL_PAGE: Readonly<Record<string, string>> = ${JSON.stringify(bareGlobalPage)};

export type DocGroup = "c" | "d" | "g" | "e";

/** Which shard directory owns \`name\`, or null if it has no docs. */
export function docGroupOf(name: string): DocGroup | null {
  if (DOC_CLASSES.has(name)) return "c";
  if (DOC_DATATYPES.has(name)) return "d";
  if (DOC_NAMESPACES.has(name)) return "g";
  if (DOC_ENUMS.has(name)) return "e";
  return null;
}
`;
mkdirSync(dirname(namesOut), { recursive: true });
writeFileSync(namesOut, nameFile, "utf8");

/* ── Type propagation tables ──────────────────────────────────────────────
 *
 * The main world carries name SETS and can therefore prove that `Humanoid` is a
 * class, but it has never been able to answer "what type is this expression",
 * so a member on anything it could not name outright went unlinked. The full
 * member tables would answer it and are ~40 kB gzipped — too much for a bundle
 * that runs at document_start on every page load.
 *
 * These two tables are the useful fraction of that. Only entries whose type is
 * itself a name the main world already knows are kept, because any other type
 * (`boolean`, `string`, a tuple) cannot be the receiver of a member access and
 * so can never link anything. That prunes ~4.8k members to a few hundred.
 *
 * What it buys, with certainty rather than by guessing:
 *
 *     local char = player.Character            -- MEMBER_TYPE: Player.Character → Model
 *     uis.InputBegan:Connect(function(input)   -- EVENT_PARAMS: → input is InputObject
 *         input.KeyCode                        -- now provable
 */
/* Classes only — deliberately not enums or datatypes.
 *
 * These tables exist to CHAIN: they answer "given `a`, what is `a.b`", so that
 * `a.b.c` can resolve. A member whose type is an enum or a datatype is a leaf
 * in practice — nobody writes `input.KeyCode.Something` expecting an engine
 * member — so those entries buy no links while costing real bytes in a bundle
 * that runs at document_start on every page load.
 *
 * Linking `input.KeyCode` itself never needed this table. That needs the type
 * of `input`, which comes from EVENT_PARAMS.
 *
 * Measured on the main-world bundle, against the same snippet resolving
 * identically in all three cases:
 *
 *     classes + datatypes + enums   1385 members   +56 kB
 *     classes + datatypes           1004 members   +40 kB
 *     classes                        314 members   +20 kB   ← this
 */
const knownType = new Set([...names["c"]!]);

const pickTypes: Record<string, Record<string, string>> = {};
for (const [cls, members] of Object.entries(memberTypes)) {
  const kept: Record<string, string> = {};
  for (const [member, type] of Object.entries(members)) {
    if (knownType.has(type)) kept[member] = type;
  }
  if (Object.keys(kept).length) pickTypes[cls] = kept;
}

const pickEvents: Record<string, Record<string, string[]>> = {};
for (const [cls, events] of Object.entries(eventParams)) {
  const kept: Record<string, string[]> = {};
  for (const [event, types] of Object.entries(events)) {
    // Keep the whole list — position matters — but only when at least one
    // parameter is a type that could ever be a receiver.
    if (types.some((t) => knownType.has(t))) kept[event] = types;
  }
  if (Object.keys(kept).length) pickEvents[cls] = kept;
}

const typeCount = Object.values(pickTypes).reduce((n, m) => n + Object.keys(m).length, 0);
const eventCount = Object.values(pickEvents).reduce((n, m) => n + Object.keys(m).length, 0);

const typesOut = resolve(root, "src/luau/member-types.generated.ts");
const typeFile = `/* GENERATED by scripts/build-docs-index.ts — do not edit.
 *
 * ${typeCount} class-typed members across ${Object.keys(pickTypes).length} classes,
 * ${eventCount} events with class-typed parameters across ${Object.keys(pickEvents).length} classes.
 *
 * Only types that are themselves known class/datatype/enum names are kept — a
 * \`boolean\` cannot be the receiver of a member access, so carrying it would
 * cost bundle size and link nothing.
 */

/** Owner class → member → the class/datatype/enum that member evaluates to. */
export const MEMBER_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> =
${JSON.stringify(pickTypes, null, 0)};

/** Owner class → event → parameter types, in order. */
export const EVENT_PARAMS: Readonly<Record<string, readonly (readonly string[])[] | Readonly<Record<string, readonly string[]>>>> =
${JSON.stringify(pickEvents, null, 0)};

/** The declared type of \`Owner.member\`, when it is one this bundle knows. */
export function memberType(owner: string, member: string): string | undefined {
  return MEMBER_TYPE[owner]?.[member];
}

/** Parameter types of \`Owner.event\`, in order. */
export function eventParamTypes(owner: string, event: string): readonly string[] | undefined {
  const byClass = EVENT_PARAMS[owner] as Readonly<Record<string, readonly string[]>> | undefined;
  return byClass?.[event];
}
`;
writeFileSync(typesOut, typeFile, "utf8");
console.log(
  `  docs-index: member types ${typeCount} members, ${eventCount} events ` +
    `(${(typeFile.length / 1024).toFixed(0)} kB source)`,
);

let totalBytes = 0;
let totalFiles = 0;
let totalMembers = 0;
for (const [label, s] of Object.entries(stats)) {
  totalBytes += s.bytes;
  totalFiles += s.files;
  totalMembers += s.members;
  console.log(
    `  docs-index: ${label.padEnd(10)} ${String(s.files).padStart(4)} shards, ` +
      `${String(s.members).padStart(6)} members, ${(s.bytes / 1024).toFixed(0)} kB`,
  );
}
console.log(
  `  docs-index: members.json ${(verifyJson.length / 1024).toFixed(0)} kB ` +
    `(${Object.keys(verify).length} owners, fetched lazily)`,
);
console.log(
  `docs-index: ${totalFiles} shards, ${totalMembers} members, ` +
    `${(totalBytes / 1024 / 1024).toFixed(2)} MB on disk, ` +
    `${(nameFile.length / 1024).toFixed(1)} kB of names in the bundle ` +
    `(Creator Docs ${studioVersion})`,
);
