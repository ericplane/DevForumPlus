/**
 * Compile the Roblox API surface into an index the extension can ship.
 *
 * Source of truth is Roblox's own API dump (7.1 MB, 900 classes, 614 enums),
 * which tags deprecated classes and members directly — 45 and 458 of them
 * respectively as of writing. That is authoritative in a way a hand-written
 * list never could be, and it is why the deprecation feature can claim to be
 * correct rather than opinionated.
 *
 * What the dump does NOT contain, verified against the live file: any
 * replacement hint. There is no PreferredDescriptorName on a single member. So
 * `data/curated-deprecations.json` supplies the replacements and the reasoning,
 * and this script merges the two.
 *
 * Runs in CI, not on the user's machine. The output ships inside the extension,
 * so the feature works offline and never touches GitHub at runtime.
 *
 * Run: npm run api-index
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DUMP_URL =
  "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json";
const VERSION_URL = "https://setup.rbxcdn.com/versionQTStudio";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outFile = resolve(root, "src/luau/api-index.generated.ts");
const cacheFile = resolve(root, "node_modules/.cache/dfp-api-dump.json");

type Severity = "error" | "warn" | "info";

interface Entry {
  /** null means "removed, no replacement". */
  replacement: string | null;
  severity: Severity;
  why: string;
  /** Only flag when the receiver looks like one of these. */
  onlyAfter?: string[];
  /**
   * Which access form counts. `event:wait()` is a legacy alias; `task.wait()`
   * is the modern API — without this they are indistinguishable by name.
   */
  access?: "method" | "property";
}

interface Dump {
  Version: number;
  Classes: {
    Name: string;
    Superclass?: string;
    Tags?: string[];
    Members?: { Name: string; MemberType: string; Tags?: string[] }[];
  }[];
}

interface Curated {
  globals: Record<string, Entry>;
  members: Record<string, Entry>;
  classes: Record<string, Entry>;
  patterns: Record<string, Omit<Entry, "replacement"> & { replacement: string }>;
}

async function loadDump(): Promise<Dump> {
  // Cached so a rebuild does not re-download 7 MB; CI starts cold anyway.
  if (existsSync(cacheFile)) {
    console.log("  api-index: using cached dump");
    return JSON.parse(readFileSync(cacheFile, "utf8")) as Dump;
  }
  console.log("  api-index: downloading API dump…");
  const res = await fetch(DUMP_URL);
  if (!res.ok) throw new Error(`API dump fetch failed: ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, text, "utf8");
  return JSON.parse(text) as Dump;
}

async function studioVersion(): Promise<string> {
  try {
    const res = await fetch(VERSION_URL);
    return res.ok ? (await res.text()).trim() : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Member names too generic to match safely.
 *
 * The detector only fires after a `.` or `:`, but a name like `remove` or
 * `wait` still appears on plenty of user-written tables. Those are kept because
 * the curated file gives them a real explanation and an `info` severity; what
 * is dropped here are dump-derived names short enough to collide constantly
 * with ordinary code. A false positive on someone's own method is worse than a
 * missed legacy alias.
 */
const TOO_GENERIC = new Set([
  "add", "get", "set", "new", "run", "load", "size", "value", "name", "data",
  "part", "item", "type", "text", "time", "step", "play", "stop", "reset",
]);

function build(dump: Dump, curated: Curated) {
  const classes: Record<string, Entry> = {};

  const fallback = (what: string): Entry => ({
    replacement: null,
    severity: "info",
    why: `${what} is marked deprecated in Roblox's API dump.`,
  });

  /**
   * Deprecated members grouped by the class that declares them, NOT flattened
   * into one name list.
   *
   * The flat version shipped first and was wrong. A snippet rarely says what
   * type a receiver is — `bv.Velocity` gives us `bv` — so matching by bare name
   * was the only option, and it means one class's deprecation condemns the same
   * name everywhere. `Velocity` is the case that exposed it: deprecated on
   * BasePart, correct on BodyVelocity. Marking it told people the right property
   * was wrong. Names like `fire`, `move` and `target` are worse still, because
   * they collide with the reader's own code rather than another Roblox class.
   *
   * Keyed by class, the detector can instead resolve the receiver (from
   * `Instance.new("X")`, `game:GetService("X")` or a known global) and ask
   * whether the member is deprecated *on that class* — walking `superclass` so
   * `Part` inherits BasePart's list. Receivers it cannot resolve get no
   * dump-derived finding at all, which is the honest answer.
   */
  /* Names only, space-joined. Storing an Entry per member meant shipping the
   * same generated sentence 458 times; the reason text is identical apart from
   * the owning class, so it is synthesised at lookup instead. */
  const classMembers: Record<string, string> = {};
  const superclass: Record<string, string> = {};

  for (const cls of dump.Classes) {
    if ((cls.Tags ?? []).includes("Deprecated")) {
      classes[cls.Name] = curated.classes[cls.Name] ?? fallback(cls.Name);
    }
    if (cls.Superclass && cls.Superclass !== "<<<ROOT>>>") {
      superclass[cls.Name] = cls.Superclass;
    }
    const dep = (cls.Members ?? [])
      .filter((m) => (m.Tags ?? []).includes("Deprecated"))
      .map((m) => m.Name)
      .filter((n) => !TOO_GENERIC.has(n.toLowerCase()));
    if (dep.length) classMembers[cls.Name] = dep.join(" ");
  }

  /* Prune the inheritance map to links that can actually reach a deprecation.
   * Most of the 900 classes have no deprecated members anywhere in their chain,
   * and their parent pointers are payload nobody reads. */
  const useful = new Set<string>();
  for (const name of Object.keys(superclass)) {
    let cur: string | undefined = name;
    const seen: string[] = [];
    while (cur) {
      seen.push(cur);
      if (classMembers[cur]) {
        for (const s of seen) useful.add(s);
        break;
      }
      cur = superclass[cur];
    }
  }
  for (const name of Object.keys(superclass)) {
    if (!useful.has(name)) delete superclass[name];
  }

  // Curated entries the dump does not know about at all.
  for (const [name, entry] of Object.entries(curated.classes)) classes[name] = entry;

  // Every class name, for linking identifiers to Creator Docs. Names only —
  // descriptions would multiply the payload for something a link already gives.
  const known = dump.Classes.map((c) => c.Name).sort();

  const memberCount = Object.values(classMembers).reduce(
    (n, m) => n + m.split(" ").length,
    0,
  );

  return {
    classes,
    classMembers,
    superclass,
    memberCount,
    /* Matched by bare name on any receiver. Only the curated set earns this:
     * every entry is a lowercase legacy alias with no current counterpart, and
     * carries an `access` form so `task.wait()` is not confused with
     * `event:wait()`. */
    members: curated.members,
    globals: curated.globals,
    patterns: curated.patterns,
    known,
  };
}

const curated = JSON.parse(
  readFileSync(resolve(root, "data/curated-deprecations.json"), "utf8"),
) as Curated & { _comment?: unknown };
delete curated._comment;

const dump = await loadDump();
const version = await studioVersion();
const index = build(dump, curated);

const counts = {
  classes: Object.keys(index.classes).length,
  members: Object.keys(index.members).length,
  globals: Object.keys(index.globals).length,
  known: index.known.length,
};

const out = `/* GENERATED by scripts/build-api-index.ts — do not edit.
 *
 * Source: Roblox API dump (${dump.Classes.length} classes) merged with
 * data/curated-deprecations.json.
 * Studio version at generation: ${version}
 *
 * ${counts.classes} deprecated classes, ${index.memberCount} deprecated members
 * across ${Object.keys(index.classMembers).length} classes, ${counts.members} name-matched
 * aliases, ${counts.globals} deprecated globals, ${counts.known} known class names.
 */

export type Severity = "error" | "warn" | "info";

export interface ApiEntry {
  replacement: string | null;
  severity: Severity;
  why: string;
  /* readonly, because API_INDEX below is \`as const\` — a mutable string[] here
   * makes every lookup cast fail. */
  readonly onlyAfter?: readonly string[];
  readonly access?: "method" | "property";
}

export const API_INDEX = ${JSON.stringify(
  {
    version,
    classes: index.classes,
    members: index.members,
    classMembers: index.classMembers,
    superclass: index.superclass,
    globals: index.globals,
    patterns: index.patterns,
  },
  null,
  2,
)} as const;

/**
 * Is \`member\` deprecated on \`className\`, or on anything it inherits from?
 *
 * Walking the chain matters: BasePart declares most of the deprecated part
 * surface, and forum code says \`Instance.new("Part")\`.
 *
 * Returns a curated entry when one exists — those carry the replacement and the
 * real reason — and otherwise synthesises the dump's plainer statement.
 */
const memberSets = new Map<string, Set<string>>();

export function deprecatedOn(className: string, member: string): ApiEntry | null {
  const owners = API_INDEX.classMembers as Record<string, string>;
  const parents = API_INDEX.superclass as Record<string, string>;
  const curated = API_INDEX.members as Record<string, ApiEntry>;

  let cls: string | undefined = className;
  // Bounded so a malformed index cannot spin: the real chain is ~6 deep.
  for (let depth = 0; cls && depth < 24; depth++) {
    const packed = owners[cls];
    if (packed) {
      let set = memberSets.get(cls);
      if (!set) {
        set = new Set(packed.split(" "));
        memberSets.set(cls, set);
      }
      if (set.has(member)) {
        return (
          curated[member] ?? {
            replacement: null,
            severity: "info",
            why: \`\${cls}.\${member} is marked deprecated in Roblox's API dump.\`,
          }
        );
      }
    }
    cls = parents[cls];
  }
  return null;
}

/** Class names that resolve to a Creator Docs page. */
export const KNOWN_CLASSES: ReadonlySet<string> = new Set(${JSON.stringify(index.known)});

export const DOCS_BASE = "https://create.roblox.com/docs/reference/engine/classes/";
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out, "utf8");

const kb = (out.length / 1024).toFixed(1);
console.log(
  `api-index: ${counts.classes} classes, ${counts.members} members, ` +
    `${counts.globals} globals, ${counts.known} known names → ${kb} kB`,
);
