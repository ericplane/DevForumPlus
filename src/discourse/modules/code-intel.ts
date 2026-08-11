import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import {
  detect,
  inferLocalTypes,
  isTypePosition,
  isAnnotationColon,
  isFunctionNameSite,
  declaredNames,
  exprTypeBefore,
  GLOBAL_TYPES,
  type Finding,
} from "../../luau/detect";
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

/**
 * Structure only Luau has. Any one of these is enough on its own.
 *
 * A local declaration that assigns or annotates, a `:GetService(` call, or a
 * long comment — none of which survive being read as any other language in a
 * `<pre>`.
 */
const LUAU_SIGNALS = [
  /\blocal\s+(?:function\b|[A-Za-z_]\w*\s*[:=,])/,
  /[.:]GetService\s*\(/,
  /--\[=*\[/,
];

/**
 * An opener that Luau closes with `end`.
 *
 * `do` is not one of them on its own — it is a common English word, and this
 * runs on classless blocks that sometimes hold prose. The loop header is matched
 * whole instead (`for i = `, `for k, v in `), which is a shape neither prose nor
 * JavaScript produces; Python's `for x in y:` produces it but has no `end`.
 */
const BLOCK_OPENER =
  /\b(?:function|then)\b|\bfor\s+[A-Za-z_]\w*\s*(?:,\s*[A-Za-z_]\w*\s*)*(?:=|\bin\b)/;

/**
 * `end` closing a block, rather than somebody's variable called `end`.
 *
 * A terminator ends a statement: nothing hands it to anything, and it takes no
 * arguments. So it is never preceded by `,` `(` `[` `=` `:` or a quote — which
 * covers `line[start:end]`, `slice(start, end)`, `{"end": 2}` and the JS shape
 * that survives every looser test,
 * `function trim(s, start, end) { return s.slice(start, end); }` — and it is
 * never followed by an assignment, call, index or member access.
 *
 * Anchoring to the start of a line would have been simpler and was tried; it
 * rejects the one-line paste this forum is full of,
 * `part.Touched:Connect(function(hit) hit:Destroy() end)`.
 */
const END_KEYWORD = /(?<![,([=:"'][ \t]{0,8})\bend\b(?![ \t]*[=({[.:])/;

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

  /* The two halves of this test used to share an alternation —
   * `/\b(local|function|end|then|elseif)\b/ && /\bend\b/` — and because `end`
   * appeared in both, the whole expression reduced to `/\bend\b/`. It claimed
   * `return line[start:end]`, `str.slice(start, end)`,
   * `WHERE id BETWEEN start AND end;` and the English sentence "read the thread
   * to the end please", painting each as Luau and hanging fake deprecation marks
   * on any `spawn` or `wait` in them — while rejecting
   * `local Players = game:GetService("Players")` for not containing `end`.
   * Keep the signals disjoint: a bare `end` proves nothing by itself. */
  if (LUAU_SIGNALS.some((re) => re.test(text))) return true;
  return BLOCK_OPENER.test(text) && END_KEYWORD.test(text);
}

const KIND_CLASS: Partial<Record<TokenKind, string>> = {
  keyword: "dfp-tok-kw",
  builtin: "dfp-tok-builtin",
  legacy: "dfp-tok-legacy",
  string: "dfp-tok-str",
  number: "dfp-tok-num",
  comment: "dfp-tok-com",
  operator: "dfp-tok-op",
  /* Punctuation is the same syntactic category as `=` and `..`, and it used to
   * be the brightest thing in the block: unmapped, `.`/`:`/`,`/parens/braces
   * inherited `--dfp-text` at OKLab L 0.966 against the operators' 0.782 beside
   * them — 1.80:1, decided only by which characters happened to be listed in the
   * tokenizer's operator string. */
  punct: "dfp-tok-op",
  /* Never emitted by the tokenizer — see TokenKind. Mapped so the two
   * vocabularies stay one list; the class is assigned by position below. */
  type: "dfp-tok-type",
};

/**
 * Field and method names, coloured from position alone.
 *
 * Every name after a `.` or `:` was previously a bare `ident` and rendered the
 * same plain white as a local variable, so `killbrick.Touched:Connect(…)` came
 * out with `Touched` and `Connect` looking exactly like `killbrick`. Naming
 * what you are reaching into is the single most useful colour in a language
 * built on `a.b:c()`, and it needs no type inference at all — the separator
 * proves it.
 *
 * Deliberately done here rather than in the tokenizer: `detect.ts` keys the
 * deprecation scanner off `kind === "ident"` in four places, so introducing new
 * kinds upstream would silently stop it finding anything.
 *
 * `:` is a method call and `.` is a field access, which is what Luau's own
 * syntax means, so they get different colours rather than one shared one.
 */
function memberClass(prevValue: string | undefined, kind: TokenKind): string | undefined {
  if (kind !== "ident" && kind !== "builtin") return undefined;
  if (prevValue === ":") return "dfp-tok-method";
  if (prevValue === ".") return "dfp-tok-prop";
  return undefined;
}

export interface SegmentPart {
  text: string;
  cls?: string;
}

export interface Segment {
  text: string;
  cls?: string;
  finding?: Finding;
  /** `"TweenService"` or `"TweenService.Create"` — resolved against the docs. */
  api?: string;
  /**
   * Set only when a finding swallowed more than one token: the pieces, each
   * keeping its own colour. See the mark branch in `renderBlock`.
   */
  parts?: SegmentPart[];
}

/** Index of the next/previous significant token, or -1. Never a Token — see `segment`. */
type Look = (i: number) => number;

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
  declared: Set<string>,
  after: Look,
  before: Look,
): string | undefined {
  const t = tokens[i]!;

  // ── A class name inside a string the engine treats as a class name ───────
  // `Instance.new("Part")`, `:GetService("Players")`, `:IsA("Humanoid")`,
  // `:FindFirstChildOfClass("Humanoid")`. Unambiguous by position.
  if (t.kind === "string") {
    const openIdx = before(i);
    const fnIdx = openIdx >= 0 && tokens[openIdx]!.value === "(" ? before(openIdx) : -1;
    if (fnIdx >= 0 && CLASS_STRING_FNS.has(tokens[fnIdx]!.value)) {
      const name = t.value.slice(1, -1);
      if (DOC_CLASSES.has(name)) return name;
    }
    return undefined;
  }

  if (t.kind !== "ident" && t.kind !== "builtin" && t.kind !== "legacy") return undefined;

  const prevIdx = before(i);
  const nextIdx = after(i);
  const prev = prevIdx >= 0 ? tokens[prevIdx]! : null;
  const next = nextIdx >= 0 ? tokens[nextIdx]! : null;
  const afterDot = prev?.value === "." || prev?.value === ":";
  /* `local hum: Humanoid` puts a `:` after `hum` in exactly the place a method
   * call puts one, so `hum` entered the receiver branch and resolved through
   * `localTypes` — which was filled in from that very annotation. The dotted
   * docs underline ended up on the one token that is definitionally not an API
   * name, while the class name three characters away stayed bare. An annotation
   * colon is not a receiver. */
  const isReceiver =
    next?.value === "." || (next?.value === ":" && !isAnnotationColon(tokens, nextIdx));

  // ── Member of something whose owner is known ─────────────────────────────
  if (afterDot) {
    /* `exprTypeBefore` first, because it also resolves a receiver that is a call
     * rather than a name — `game:GetService("UserInputService").InputBegan`, the
     * form people paste when they quote a single statement. `ownerOf` still
     * handles the cases it knows: a class or namespace used directly. */
    const recvIdx = before(prevIdx);
    const owner =
      exprTypeBefore(tokens, prevIdx, localTypes) ??
      (recvIdx >= 0 ? ownerOf(tokens[recvIdx]!, localTypes, declared) : undefined);
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
    // A local whose class we inferred: `part.Anchored` links `part` to Part.
    // First, because what a name was *proved* to be outranks how it is spelled.
    const local = localTypes.get(t.value);
    if (local) return DOC_CLASSES.has(local) ? local : undefined;
    /* And nothing is resolved by spelling once the snippet has declared the
     * name itself. `local Skin = {}` linked `Skin` to classes/Skin, and
     * `local Model: number = 5` linked `Model` to classes/Model — from the
     * spelling alone, which is the one thing this function's own contract says
     * it never does. */
    if (declared.has(t.value)) return undefined;
    if (DOC_CLASSES.has(t.value) || DOC_DATATYPES.has(t.value) || DOC_NAMESPACES.has(t.value)) {
      return t.value;
    }
    // `game`/`workspace`/`script` are objects, not namespaces — link the class
    // they actually are.
    const g = GLOBAL_TYPES[t.value];
    if (g && DOC_CLASSES.has(g)) return g;
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
function ownerOf(
  recv: Token,
  localTypes: Map<string, string>,
  declared: Set<string>,
): string | undefined {
  if (recv.kind !== "ident" && recv.kind !== "builtin" && recv.kind !== "legacy") return undefined;
  const v = recv.value;
  // `Enum` is a marker, not a page — the caller uses it to read the next hop.
  if (v === "Enum") return "Enum";
  const local = localTypes.get(v);
  if (local && DOC_CLASSES.has(local)) return local;
  // Same veto as the receiver branch above: a name the snippet declared for
  // itself is not the engine class that happens to share its spelling.
  if (declared.has(v)) return undefined;
  if (DOC_NAMESPACES.has(v) || DOC_DATATYPES.has(v) || DOC_CLASSES.has(v)) return v;
  // `Enum.KeyCode.Space` — reached here as the receiver `KeyCode`.
  if (DOC_ENUMS.has(v)) return v;
  const g = GLOBAL_TYPES[v];
  if (g && DOC_CLASSES.has(g)) return g;
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
  const declared = declaredNames(tokens);
  const findingAt = new Map<number, Finding>();
  for (const f of findings) findingAt.set(f.start, f);

  /* Indices, not tokens. Everything downstream needs to keep walking from
   * whatever it was handed, and handing it a Token meant finding the way back
   * with `tokens.indexOf(…)`: eighteen of those on this path, 7.44M comparisons
   * on a 3,263-token block, 70% of them inside `isDefinitionSite`. A 1,247-line
   * block went from 30.4ms to 6.7ms. Do not put an `indexOf` back. */
  const after: Look = (i) => {
    for (let j = i + 1; j < tokens.length; j++) {
      const k = tokens[j]!.kind;
      if (k !== "whitespace" && k !== "comment") return j;
    }
    return -1;
  };
  const before: Look = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      const k = tokens[j]!.kind;
      if (k !== "whitespace" && k !== "comment") return j;
    }
    return -1;
  };

  /**
   * What a token looks like on its own, and whether a docs link may hang on it.
   *
   * Both answers come from the same two questions, so they are asked once.
   */
  const styleAt = (i: number): { cls?: string; ref?: string } => {
    const t = tokens[i]!;
    const prevIdx = before(i);

    /* A declaration outranks everything: `local function step()`,
     * `function foo()`, `function M.init()` and `function M:update()` are one
     * thing wearing four spellings, and they used to come out with no class, no
     * class, a field colour and a method colour — a definition byte-identical to
     * every call site. And no link may be built here at all: `local Sound = {}`
     * plus `function Sound:Play()` produced `Sound.Play`, which the isolated
     * world confirms against the real member index and turns into a live link to
     * the engine's Sound.Play. The rule this file states is a missing link, not
     * a lying one. */
    if (isFunctionNameSite(tokens, i)) return { cls: "dfp-tok-fn" };

    /* `local h: Humanoid`, `f(a: number): boolean`, `type P = { x: number }`.
     * The annotation is the class, so the link belongs on it rather than on the
     * variable in front of it — and it is a type, so it is not a method call,
     * whatever the colon in front of it suggests.
     *
     * Names only: a type expression also contains braces, arrows and parens, and
     * those are punctuation wherever they appear. */
    const isNameKind = t.kind === "ident" || t.kind === "builtin" || t.kind === "legacy";
    if (isNameKind && isTypePosition(tokens, i, prevIdx)) {
      return { cls: "dfp-tok-type", ref: typeRef(t, declared) };
    }

    return {
      cls: memberClass(prevIdx >= 0 ? tokens[prevIdx]!.value : undefined, t.kind) ?? KIND_CLASS[t.kind],
      ref: apiRefAt(tokens, i, localTypes, declared, after, before),
    };
  };

  const out: Segment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const finding = findingAt.get(t.start);
    if (finding && finding.end >= t.end) {
      /* A finding may span several tokens — `Instance.new("Part", workspace)`
       * marks the whole `, workspace` argument, since that is what has to go.
       * Swallow them into one segment so the mark is one continuous underline,
       * but keep each token's own class: the old ternary dropped the class the
       * moment a second token joined, so
       * `Instance.new("ScreenGui", game.Players.LocalPlayer:WaitForChild("PlayerGui"))`
       * flattened a builtin, two properties, a method and a string to plain
       * white under the underline. */
      const parts: SegmentPart[] = [{ text: t.value, cls: styleAt(i).cls }];
      let text = t.value;
      while (i + 1 < tokens.length && tokens[i + 1]!.end <= finding.end) {
        i++;
        text += tokens[i]!.value;
        parts.push({ text: tokens[i]!.value, cls: styleAt(i).cls });
      }
      out.push(
        parts.length === 1
          ? { text, cls: parts[0]!.cls, finding }
          : { text, finding, parts },
      );
      continue;
    }

    const { cls, ref } = styleAt(i);
    out.push({ text: t.value, cls, api: ref });
  }

  return out;
}

/**
 * The docs page for a name used as a type: `local hum: Humanoid`.
 *
 * Owner-level, so it ships as a real link. Vetoed for anything the snippet
 * declared itself, which is what keeps a hand-written `type Tool = { … }` from
 * pointing at the engine's Tool.
 */
function typeRef(t: Token, declared: Set<string>): string | undefined {
  const v = t.value;
  if (declared.has(v)) return undefined;
  if (DOC_CLASSES.has(v) || DOC_DATATYPES.has(v) || DOC_ENUMS.has(v)) return v;
  return undefined;
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
      if (seg.parts) {
        /* Nested spans, because the mark is an underline rather than a recolour:
         * a finding that spans `, game.Workspace` has to keep the builtin and
         * the property underneath it looking like a builtin and a property.
         * Elements and text nodes, never innerHTML — this is post content. */
        for (const part of seg.parts) {
          if (!part.cls) {
            mark.appendChild(document.createTextNode(part.text));
            continue;
          }
          const piece = document.createElement("span");
          piece.className = part.cls;
          piece.textContent = part.text;
          mark.appendChild(piece);
        }
      } else {
        mark.textContent = seg.text;
      }
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
    /* This number measures nothing, and the claim it used to carry — that the
     * registry disables the module if the tokenizing proves too expensive — was
     * false. registry.ts wraps `install()` only, and install here is a single
     * `decorateCooked` call that registers a hook and queues deferred sweeps, so
     * it reads about 0ms however much code the page contains. Every block this
     * module actually tokenizes is processed later, in passes nothing measures
     * (see discourse/decorate.ts, which documents the same thing from the other
     * side). Kept because the registry requires a number; read it as a
     * placeholder, not as a budget. */
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
