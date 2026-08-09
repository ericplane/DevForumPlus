import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { detect, inferLocalTypes, GLOBAL_TYPES, type Finding } from "../../luau/detect";
import {
  DOC_CLASSES,
  DOC_DATATYPES,
  DOC_NAMESPACES,
  DOC_ENUMS,
  DOC_BARE_GLOBALS,
  DOC_GLOBAL_PAGE,
} from "../../luau/docs-names.generated";
import { tokenize, type Token, type TokenKind } from "../../luau/tokenizer";

/** Everything under create.roblox.com's engine reference hangs off this. */
const DOCS_ROOT = "https://create.roblox.com/docs/reference/engine/";

/**
 * Luau code intelligence in posts.
 *
 * Three things, all driven off one tokenizer pass:
 *
 *  1. Correct highlighting. Verified from the forum's own site settings:
 *     `highlighted_languages` lists `lua` and has no `luau` entry, so every
 *     Luau snippet here is currently tokenised by highlight.js's Lua grammar.
 *     Type annotations, `::` casts, `continue`, generics, compound assignment
 *     and backtick interpolation all render wrong.
 *
 *  2. Deprecated API marks, from Roblox's own API dump.
 *
 *  3. Creator Docs links on class names.
 *
 * Presentation is deliberately advisory. These are other people's posts, often
 * years old, and the author cannot edit them — so findings are an underline and
 * a hover, never a banner, never a blocking overlay, and never a claim that the
 * post is wrong.
 */

const PROCESSED = "data-dfp-code";

/** Discourse tags fenced blocks `lang-lua`; unfenced blocks have no class. */
function isLuauBlock(code: HTMLElement): boolean {
  const cls = code.className;
  if (/lang-(lua|luau)\b/.test(cls)) return true;
  // Unfenced blocks are the common case in Scripting Support. Only treat one as
  // Luau if it actually looks like it — a shell transcript or a JSON blob must
  // not get Luau colouring just for sitting in a <pre>.
  if (cls.trim() !== "") return false;
  const text = code.textContent ?? "";
  if (text.length < 12) return false;
  return /\b(local|function|end|then|elseif)\b/.test(text) && /\bend\b/.test(text);
}

const KIND_CLASS: Partial<Record<TokenKind, string>> = {
  keyword: "dfp-tok-kw",
  builtin: "dfp-tok-builtin",
  string: "dfp-tok-str",
  number: "dfp-tok-num",
  comment: "dfp-tok-com",
  operator: "dfp-tok-op",
};

export interface Segment {
  text: string;
  cls?: string;
  finding?: Finding;
  /** `"TweenService"` or `"TweenService.Create"` — resolved against the docs. */
  api?: string;
}

type Look = (i: number) => Token | null;

/**
 * Does the token at `i` name something with a Creator Docs page?
 *
 * Returns `Owner` or `Owner.Member`, which the isolated world turns into a card.
 * Every case below is one where the *position* of the token proves what it is,
 * never its spelling alone — the same discipline the deprecation detector needs,
 * for the same reason. `local Skin = …` must not link `Skin` to a class page it
 * has nothing to do with, and someone's own `self.Position` must not claim to be
 * `BasePart.Position`.
 */
function apiRefAt(
  tokens: Token[],
  i: number,
  localTypes: Map<string, string>,
  after: Look,
  before: Look,
): string | undefined {
  const t = tokens[i]!;

  // ── A class name inside a string the engine treats as a class name ───────
  // `Instance.new("Part")`, `:GetService("Players")`, `:IsA("Humanoid")`,
  // `:FindFirstChildOfClass("Humanoid")`. Unambiguous by position.
  if (t.kind === "string") {
    const open = before(i);
    const fn = open?.value === "(" ? before(tokens.indexOf(open)) : null;
    if (fn && CLASS_STRING_FNS.has(fn.value)) {
      const name = t.value.slice(1, -1);
      if (DOC_CLASSES.has(name)) return name;
    }
    return undefined;
  }

  if (t.kind !== "ident" && t.kind !== "builtin") return undefined;

  const prev = before(i);
  const next = after(i);
  const afterDot = prev?.value === "." || prev?.value === ":";
  const isReceiver = next?.value === "." || next?.value === ":";

  // ── Member of something whose owner is known ─────────────────────────────
  if (afterDot) {
    const recv = before(tokens.indexOf(prev!));
    if (!recv) return undefined;
    const owner = ownerOf(recv, localTypes);
    if (!owner) return undefined;

    // `Enum.KeyCode.Space` — the middle segment is the enum, the last its item.
    // Resolving the item needs the enum, not `Enum` itself.
    if (owner === "Enum" && DOC_ENUMS.has(t.value)) return t.value;

    /* `game.Players`, `game.Debris`, `game.ReplicatedStorage`. Services are not
     * documented as properties of DataModel, so treating these as members finds
     * nothing — but the member name IS the service class, and that is the page
     * a reader wants. Provable here from DOC_CLASSES, so it links immediately
     * rather than waiting to be confirmed. */
    if (owner === "DataModel" && DOC_CLASSES.has(t.value)) return t.value;

    return `${owner}.${t.value}`;
  }

  // ── A namespace or class used as a receiver ──────────────────────────────
  // `TweenService:Create`, `task.wait`, `Vector3.new`, `Enum.KeyCode`.
  if (isReceiver) {
    if (DOC_CLASSES.has(t.value) || DOC_DATATYPES.has(t.value) || DOC_NAMESPACES.has(t.value)) {
      return t.value;
    }
    // `game`/`workspace`/`script` are objects, not namespaces — link the class
    // they actually are.
    const g = GLOBAL_TYPES[t.value];
    if (g && DOC_CLASSES.has(g)) return g;
    // A local whose class we inferred: `part.Anchored` links `part` to Part.
    const local = localTypes.get(t.value);
    if (local && DOC_CLASSES.has(local)) return local;
    return undefined;
  }

  // ── A bare global: `print`, `pcall`, `tick`, `warn`, `require` ───────────
  // Only as a call or a bare reference, and never where it is being declared.
  if (DOC_BARE_GLOBALS.has(t.value)) {
    const shadowed = prev?.kind === "keyword" && prev.value === "local";
    const assigned = next?.kind === "operator" && next.value === "=";
    if (!shadowed && !assigned) return `globals.${t.value}`;
  }

  return undefined;
}

/**
 * The create.roblox.com page for an API reference.
 *
 * This is the `href`, so it has to work even when the hover card never loads —
 * middle-clicking a token should still open the right docs page.
 */
export function docsUrl(api: string): string {
  const [owner, member] = api.split(".") as [string, string?];
  const hash = member ? `#${member}` : "";
  if (owner === "globals" && member) {
    const page = DOC_GLOBAL_PAGE[member] ?? "RobloxGlobals";
    return `${DOCS_ROOT}globals/${page}#${member}`;
  }
  if (DOC_CLASSES.has(owner)) return `${DOCS_ROOT}classes/${owner}${hash}`;
  if (DOC_DATATYPES.has(owner)) return `${DOCS_ROOT}datatypes/${owner}${hash}`;
  if (DOC_NAMESPACES.has(owner)) return `${DOCS_ROOT}libraries/${owner}${hash}`;
  if (DOC_ENUMS.has(owner)) return `${DOCS_ROOT}enums/${owner}${hash}`;
  return `${DOCS_ROOT}classes/${owner}${hash}`;
}

/** Functions whose string argument is a class name. */
const CLASS_STRING_FNS = new Set([
  "new",
  "GetService",
  "IsA",
  "FindFirstChildOfClass",
  "FindFirstChildWhichIsA",
  "FindFirstAncestorOfClass",
  "FindFirstAncestorWhichIsA",
  "GetPropertyChangedSignal",
]);

/** What class, datatype, namespace or enum does this receiver denote? */
function ownerOf(recv: Token, localTypes: Map<string, string>): string | undefined {
  if (recv.kind !== "ident" && recv.kind !== "builtin") return undefined;
  const v = recv.value;
  // `Enum` is a marker, not a page — the caller uses it to read the next hop.
  if (v === "Enum") return "Enum";
  if (DOC_NAMESPACES.has(v) || DOC_DATATYPES.has(v) || DOC_CLASSES.has(v)) return v;
  // `Enum.KeyCode.Space` — reached here as the receiver `KeyCode`.
  if (DOC_ENUMS.has(v)) return v;
  const g = GLOBAL_TYPES[v];
  if (g && DOC_CLASSES.has(g)) return g;
  const local = localTypes.get(v);
  if (local && DOC_CLASSES.has(local)) return local;
  return undefined;
}

/**
 * Build a flat list of styled segments.
 *
 * Findings win over token classes where they overlap, because a deprecation
 * mark carries more information than a colour. Everything is emitted as text
 * nodes and elements — never innerHTML — since this runs over untrusted post
 * content.
 */
export function segment(source: string): Segment[] {
  const tokens = tokenize(source);
  const findings = detect(source);
  const localTypes = inferLocalTypes(tokens);
  const findingAt = new Map<number, Finding>();
  for (const f of findings) findingAt.set(f.start, f);

  /** Next token that is not whitespace or a comment. */
  const after = (i: number) => {
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.kind !== "whitespace" && t.kind !== "comment") return t;
    }
    return null;
  };
  const before = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const t = tokens[j]!;
      if (t.kind !== "whitespace" && t.kind !== "comment") return t;
    }
    return null;
  };

  const out: Segment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const finding = findingAt.get(t.start);
    if (finding && finding.end >= t.end) {
      // A finding may span several tokens — `Instance.new("Part", workspace)`
      // marks the whole `, workspace` argument, since that is what has to go.
      // Swallow them into one segment so the mark is one continuous underline.
      let text = t.value;
      while (i + 1 < tokens.length && tokens[i + 1]!.end <= finding.end) {
        text += tokens[++i]!.value;
      }
      const cls = text === t.value ? KIND_CLASS[t.kind] : undefined;
      out.push({ text, cls, finding });
      continue;
    }

    const api = apiRefAt(tokens, i, localTypes, after, before);
    out.push({ text: t.value, cls: KIND_CLASS[t.kind], api });
  }

  return out;
}

function renderBlock(code: HTMLElement): Finding[] {
  const source = code.textContent ?? "";
  const segments = segment(source);
  const frag = document.createDocumentFragment();
  const found: Finding[] = [];

  for (const seg of segments) {
    if (!seg.finding && !seg.cls && !seg.api) {
      frag.appendChild(document.createTextNode(seg.text));
      continue;
    }

    if (seg.finding) {
      found.push(seg.finding);
      const mark = document.createElement("span");
      mark.className = `dfp-dep dfp-dep--${seg.finding.entry.severity}`;
      if (seg.cls) mark.classList.add(seg.cls);
      mark.textContent = seg.text;
      const { replacement, why } = seg.finding.entry;
      mark.setAttribute(
        "title",
        replacement
          ? `Deprecated — use ${replacement}. ${why}`
          : `Deprecated. ${why}`,
      );
      mark.dataset["dfpReplacement"] = replacement ?? "";
      mark.dataset["dfpWhy"] = why;
      frag.appendChild(mark);
      continue;
    }

    if (seg.api) {
      const a = document.createElement("a");
      a.textContent = seg.text;
      if (seg.cls) a.className = seg.cls;
      /* The hover card is rendered by the ISOLATED world, which owns chrome.*
       * and can read the packaged docs shards. It finds these by attribute —
       * the two worlds share the DOM, so nothing has to cross the bridge. */
      a.dataset["dfpApi"] = seg.api;

      /* Only owner-level references are linked here.
       *
       * A member-level one cannot be proved from this bundle: deciding whether
       * `ReplicatedStorage.Assets` is an engine member or a folder the author
       * made needs the member tables, and those are 28 kB gzipped — more than
       * doubling a script that runs at document_start on every page. The corpus
       * says this matters: `Workspace.Ignore`, `ReplicatedStorage.Assets`,
       * `Camera.Value` are all somebody's own instances.
       *
       * So it ships inert: an <a> with no href is not a link and not styled as
       * one. The isolated world confirms it against the real member index and
       * adds the href. Affordances are only ever ADDED, so nothing on screen is
       * ever wrong — the failure mode is a missing link, not a lying one. */
      if (!seg.api.includes(".")) {
        a.className = `dfp-doc-link${seg.cls ? ` ${seg.cls}` : ""}`;
        a.href = docsUrl(seg.api);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = `${seg.api} — Creator Docs`;
      }
      frag.appendChild(a);
      continue;
    }

    const span = document.createElement("span");
    span.className = seg.cls!;
    span.textContent = seg.text;
    frag.appendChild(span);
  }

  code.replaceChildren(frag);
  return found;
}

/**
 * A quiet line above the block naming what was found.
 *
 * Grouped, not counted. A real corpus block produced 48 findings that were all
 * the same `Instance.new(…, parent)` idiom — "48 deprecated APIs" is both a wall
 * and a lie, since that one is a replication cost rather than a deprecation.
 * Naming the distinct issues is shorter *and* more useful.
 *
 * Inserted *before* the `<pre>`, not inside it. Discourse's own copy and
 * fullscreen buttons act on the block, and a note living inside it would end up
 * pasted into someone's editor.
 */
function addSummary(pre: HTMLElement, findings: Finding[]): void {
  if (findings.length === 0) return;

  const groups = new Map<string, number>();
  for (const f of findings) {
    const label = f.kind === "pattern" ? f.text : `${f.text}`;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }

  const parts = [...groups]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  const hidden = groups.size - parts.length;
  if (hidden > 0) parts.push(`+${hidden} more`);

  const bar = document.createElement("div");
  bar.className = "dfp-code-note";
  bar.textContent = `${parts.join(" · ")} — hover for details`;
  pre.parentElement?.insertBefore(bar, pre);
}

function enhance(root: HTMLElement): void {
  const blocks = root.querySelectorAll<HTMLElement>("pre > code");
  for (const code of blocks) {
    if (code.hasAttribute(PROCESSED)) continue;
    code.setAttribute(PROCESSED, "1");
    if (!isLuauBlock(code)) continue;

    // Highlight.js may have already wrapped tokens; start from the text so the
    // Lua-grammar markup is replaced rather than nested inside ours.
    const found = renderBlock(code);
    code.classList.add("dfp-luau");

    const pre = code.parentElement;
    if (pre?.tagName === "PRE") addSummary(pre, found);
  }
}

export function codeIntel(api: PluginApi): DfpModule {
  return {
    id: "code-intel",
    // Tokenizing every block on a long thread is the most expensive thing DFP
    // does; the registry disables it if this proves optimistic.
    budgetMs: 12,

    install() {
      /* decorateCooked, not decorateCookedElement: the hook alone misses every
       * post that rendered before DFP installed, which on a hard refresh is the
       * whole first screen. See discourse/decorate.ts. */
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-code-intel",
        onlyStream: true,
      });
    },
  };
}
