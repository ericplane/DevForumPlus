import { charge, type DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { looksLikeLuauText } from "../../luau/sniff";
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
 * The first two also run in the composer preview, while the code can still be
 * changed — see the section note above `enhancePreview`.
 *
 * Presentation is deliberately advisory. These are other people's posts, often
 * years old, and the author cannot edit them — so findings are an underline and
 * a hover, never a banner, never a blocking overlay, and never a claim that the
 * post is wrong.
 */

const PROCESSED = "data-dfp-code";

/**
 * Discourse tags fenced blocks `lang-lua`; unfenced blocks have no class.
 *
 * The structural sniff for an unfenced block lives in luau/sniff.ts, shared
 * with the isolated world's composer — it used to be a copy here, and a test
 * with the history END_KEYWORD carries is exactly the kind that drifts between
 * two copies. Only the fence rule and the "a foreign class is an answer" rule
 * are this file's own.
 */
function isLuauBlock(code: HTMLElement): boolean {
  const cls = code.className;
  if (/lang-(lua|luau)\b/.test(cls)) return true;
  // Unfenced blocks are the common case in Scripting Support. Only treat one as
  // Luau if it actually looks like it — a shell transcript or a JSON blob must
  // not get Luau colouring just for sitting in a <pre>.
  if (cls.trim() !== "") return false;
  return looksLikeLuauText(code.textContent ?? "");
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
  // Only as a call or a bare reference, never where it is being assigned, and
  // never once the block has declared the name. The shadow test used to look
  // one token left for `local`, which caught `local version = 2` and nothing
  // after it: the `version` in `print(version)` two lines down still resolved
  // to `globals.version` — an inert anchor the isolated world confirms and
  // turns into a live link to the engine's `version()`, on the author's own
  // number. The same veto the receiver branch has always applied.
  if (DOC_BARE_GLOBALS.has(t.value) && !declared.has(t.value)) {
    const assigned = next?.kind === "operator" && next.value === "=";
    if (!assigned) return `globals.${t.value}`;
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

    /* A legacy name the block declared is the block's own. The dim colour is
     * the tokenizer's, and the tokenizer answers from spelling alone — so once
     * the set became the docs' flag, which lists `stats`, `version` and
     * `DebuggerManager`, `local stats = {}` / `stats.kills = 1` painted every
     * `stats` legacy with no mark and no finding: the colour-only wrong signal
     * that was taken off `time()`, moved to two ordinary variable names.
     * `apiRefAt` and detect.ts veto declared names; the colour now does too. */
    const kind: TokenKind = t.kind === "legacy" && declared.has(t.value) ? "ident" : t.kind;
    return {
      cls: memberClass(prevIdx >= 0 ? tokens[prevIdx]!.value : undefined, kind) ?? KIND_CLASS[kind],
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
      const first = styleAt(i);
      const parts: SegmentPart[] = [{ text: t.value, cls: first.cls }];
      let text = t.value;
      while (i + 1 < tokens.length && tokens[i + 1]!.end <= finding.end) {
        i++;
        text += tokens[i]!.value;
        parts.push({ text: tokens[i]!.value, cls: styleAt(i).cls });
      }
      /* A single-token finding keeps its docs reference. The mark used to be
       * pushed without one, so `wait` carried no `data-dfp-api` while the
       * unmarked `tick` beside it did — the one token a reader most wants the
       * signature and the deprecation for was the one token that had neither.
       * `styleAt` already answered; it is not asked twice. A multi-token
       * finding names an argument, not an API, so it stays bare. */
      out.push(
        parts.length === 1
          ? { text, cls: first.cls, finding, api: first.ref }
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

/** A mark the renderer placed, with the docs reference its token resolved to. */
export interface Mark {
  finding: Finding;
  api?: string;
}

interface RenderOptions {
  /**
   * Emit Creator Docs anchors on resolved tokens. Off in the composer preview:
   * every re-cook there would put a fresh set of inert member-level anchors in
   * front of the isolated world's confirm pass, which fetches the member index
   * and rewrites them — work nobody asked for on every keystroke burst, on
   * markup the next re-cook throws away.
   */
  anchors: boolean;
}

/** The native tooltip on a mark, and the no-JS fallback on a note chip. */
function markTitle(replacement: string | null, why: string): string {
  return replacement ? `Deprecated — use ${replacement}. ${why}` : `Deprecated. ${why}`;
}

function renderBlock(code: HTMLElement, opts: RenderOptions = { anchors: true }): Mark[] {
  const source = code.textContent ?? "";
  const segments = segment(source);
  const frag = document.createDocumentFragment();
  const found: Mark[] = [];

  for (const seg of segments) {
    const link = opts.anchors ? seg.api : undefined;
    if (!seg.finding && !seg.cls && link === undefined) {
      frag.appendChild(document.createTextNode(seg.text));
      continue;
    }

    if (seg.finding) {
      found.push({ finding: seg.finding, api: seg.api });
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
      /* `title` stays for now as the no-JS fallback; the isolated world's card
       * (docs-card.ts) reads the three data attributes and decides whether to
       * drop it. `data-dfp-group` is the key the note's chips look a mark up by
       * — the same text `groupMarks` groups on — because for the pattern
       * finding the mark's own text is `, parent…` while its label is
       * `Instance.new(…, parent)`, so nothing on the mark said which chip it
       * belonged to. `data-dfp-api` uses the same `Owner.member` / `globals.x`
       * vocabulary as the anchors, so one card can carry the signature and the
       * deprecation together. */
      mark.setAttribute("title", markTitle(replacement, why));
      mark.dataset["dfpReplacement"] = replacement ?? "";
      mark.dataset["dfpWhy"] = why;
      mark.dataset["dfpGroup"] = seg.finding.text;
      if (seg.api) mark.dataset["dfpApi"] = seg.api;
      frag.appendChild(mark);
      continue;
    }

    if (link !== undefined) {
      const a = document.createElement("a");
      a.textContent = seg.text;
      if (seg.cls) a.className = seg.cls;
      /* The hover card is rendered by the ISOLATED world, which owns chrome.*
       * and can read the packaged docs shards. It finds these by attribute —
       * the two worlds share the DOM, so nothing has to cross the bridge. */
      a.dataset["dfpApi"] = link;

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
      if (!link.includes(".")) {
        a.className = `dfp-doc-link${seg.cls ? ` ${seg.cls}` : ""}`;
        a.href = docsUrl(link);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = `${link} — Creator Docs`;
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

/** One distinct issue in a block, and how often it occurs. */
export interface FindingGroup {
  /** What the chip says: `wait`, `Instance.new(…, parent)`. The same text is on every mark's `data-dfp-group`. */
  label: string;
  count: number;
  replacement: string | null;
  why: string;
  /** From the first mark in the group that resolved — `globals.wait`. */
  api?: string;
}

/**
 * Group marks by what they name, most frequent first.
 *
 * Grouped, not counted. A real corpus block produced 48 findings that were all
 * the same `Instance.new(…, parent)` idiom — "48 deprecated APIs" is both a wall
 * and a lie, since that one is a replication cost rather than a deprecation.
 * Naming the distinct issues is shorter *and* more useful.
 *
 * Ties keep first-seen order (`sort` is stable), so the chips read in the
 * order a reader meets the marks.
 */
export function groupMarks(marks: readonly Mark[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const m of marks) {
    const label = m.finding.text;
    const g = groups.get(label);
    if (g) {
      g.count++;
      g.api ??= m.api;
      continue;
    }
    groups.set(label, {
      label,
      count: 1,
      replacement: m.finding.entry.replacement,
      why: m.finding.entry.why,
      api: m.api,
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Chips shown before the note folds the rest into `+N more`. */
const NOTE_LIMIT = 3;

/** On the mark a chip scrolled to, briefly. code-marks.css draws it. */
const FLASH = "dfp-dep--flash";
const FLASH_MS = 1400;

/**
 * A quiet line above the block naming what was found — and the keyboard
 * surface for the marks underneath it.
 *
 * Each group is a `<button>` chip carrying the same `data-dfp-replacement` /
 * `data-dfp-why` / `data-dfp-api` the marks carry, so the isolated world's card
 * answers on hover or focus here exactly as it does on a mark. The marks
 * themselves stay plain spans: a `tabindex` on every underline would add three
 * or four stops per block to content this extension does not own, whereas the
 * note is DFP's own element. One tab stop per block — roving `tabindex`, arrows
 * between chips — because a thread with twenty marked blocks must not cost
 * sixty presses to Tab through.
 *
 * A chip is also the way to a mark hidden under code-chrome's collapse. Over
 * 28 lines that module clips the block to 22rem with a fade, so on a long
 * paste the note told the reader there were findings they could not see and
 * left them to expand and scan for a wavy underline. Clicking a chip expands
 * through code-chrome's own button (so its label stays right), scrolls the
 * first mark of that group into view and flashes it. "N below the fold" is
 * measured on the note's first hover or focus, never in the decorator: the
 * two modules are unordered, so the note cannot know at build time whether the
 * block will be clipped, and layout reads 0 during a decorator pass anyway.
 *
 * Inserted *before* the `<pre>`, not inside it. Discourse's own copy and
 * fullscreen buttons act on the block, and a note living inside it would end up
 * pasted into someone's editor.
 */
function addSummary(pre: HTMLElement, marks: readonly Mark[]): void {
  if (marks.length === 0) return;

  const groups = groupMarks(marks);
  const shown = groups.slice(0, NOTE_LIMIT);
  const hidden = groups.length - shown.length;

  const bar = document.createElement("div");
  bar.className = "dfp-code-note";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Deprecated API findings in this code block");

  shown.forEach((g, i) => {
    if (i > 0) bar.appendChild(document.createTextNode(" · "));
    bar.appendChild(findingChip(pre, g, i === 0));
  });
  if (hidden > 0) bar.appendChild(document.createTextNode(` · +${hidden} more`));
  bar.appendChild(document.createTextNode(" — hover or Tab for details"));

  bar.addEventListener("keydown", (e) => roveChips(bar, e));
  bar.addEventListener("pointerenter", () => syncFold(bar, pre));
  bar.addEventListener("focusin", () => syncFold(bar, pre));

  pre.parentElement?.insertBefore(bar, pre);
}

function findingChip(pre: HTMLElement, g: FindingGroup, first: boolean): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "dfp-code-finding";
  chip.textContent = g.count > 1 ? `${g.label} ×${g.count}` : g.label;
  chip.tabIndex = first ? 0 : -1;
  chip.title = markTitle(g.replacement, g.why);
  chip.dataset["dfpGroup"] = g.label;
  chip.dataset["dfpReplacement"] = g.replacement ?? "";
  chip.dataset["dfpWhy"] = g.why;
  if (g.api) chip.dataset["dfpApi"] = g.api;
  chip.addEventListener("click", () => revealMark(pre, g.label));
  return chip;
}

/** Arrow keys move between chips; Tab leaves the note. */
function roveChips(bar: HTMLElement, e: KeyboardEvent): void {
  const chips = [...bar.querySelectorAll<HTMLElement>(".dfp-code-finding")];
  const from = chips.indexOf(e.target as HTMLElement);
  if (from < 0 || chips.length < 2) return;
  let to: number;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      to = (from + 1) % chips.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      to = (from - 1 + chips.length) % chips.length;
      break;
    case "Home":
      to = 0;
      break;
    case "End":
      to = chips.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  chips[from]!.tabIndex = -1;
  chips[to]!.tabIndex = 0;
  chips[to]!.focus();
}

/** Bring the first mark of a group on screen, through the collapse if need be. */
function revealMark(pre: HTMLElement, label: string): void {
  let mark: HTMLElement | null = null;
  for (const m of pre.querySelectorAll<HTMLElement>(".dfp-dep")) {
    if (m.dataset["dfpGroup"] === label) {
      mark = m;
      break;
    }
  }
  if (!mark) return;

  /* Through code-chrome's button, never by toggling the class from here. The
   * button's label is state that module owns; un-clipping behind its back
   * leaves it reading "Show all 300 lines" over a block that is already open. */
  if (pre.classList.contains("dfp-code--clipped")) {
    const expand = pre.nextElementSibling as HTMLElement | null;
    if (expand?.classList.contains("dfp-code-expand")) expand.click();
  }

  mark.scrollIntoView({ block: "center" });
  const target = mark;
  target.classList.add(FLASH);
  setTimeout(() => target.classList.remove(FLASH), FLASH_MS);
}

/**
 * "N below the fold", kept true to the block's current state.
 *
 * Recomputed on every hover or focus of the note rather than once: the reader
 * may expand the block through code-chrome's button between two hovers, and a
 * count that survives the expansion is a lie. A handful of `offsetTop` reads
 * on a hover is nothing; the same reads inside the decorator would return 0.
 */
function syncFold(bar: HTMLElement, pre: HTMLElement): void {
  let fold = bar.querySelector<HTMLElement>(".dfp-code-note__fold");
  if (!pre.classList.contains("dfp-code--clipped")) {
    fold?.remove();
    return;
  }
  const limit = pre.clientHeight;
  let below = 0;
  for (const m of pre.querySelectorAll<HTMLElement>(".dfp-dep")) {
    if (m.offsetTop + m.offsetHeight > limit) below++;
  }
  if (below === 0) {
    fold?.remove();
    return;
  }
  if (!fold) {
    fold = document.createElement("span");
    fold.className = "dfp-code-note__fold";
    bar.appendChild(fold);
  }
  fold.textContent = `${below} below the fold`;
}

function enhance(root: HTMLElement): void {
  const blocks = root.querySelectorAll<HTMLElement>("pre > code");
  for (const code of blocks) {
    if (code.hasAttribute(PROCESSED)) continue;
    code.setAttribute(PROCESSED, "1");
    if (!isLuauBlock(code)) continue;

    // Highlight.js may have already wrapped tokens; start from the text so the
    // Lua-grammar markup is replaced rather than nested inside ours.
    const marks = renderBlock(code);
    code.classList.add("dfp-luau");

    const pre = code.parentElement;
    if (pre?.tagName === "PRE") addSummary(pre, marks);
  }
}

/* ── Composer preview ─────────────────────────────────────────────────────
 *
 * The stream registration below is `onlyStream: true`, which is precisely the
 * flag that excludes Discourse's composer preview (`.d-editor-preview` inside
 * `#reply-control`). So the one place an author could still fix a `wait()` or
 * a `BodyVelocity` — while writing — showed highlight.js's Lua colouring and no
 * mark, and DFP's colours and marks arrived only once the post could no longer
 * be edited in place. code.css already frames the preview's `<pre>` in DFP's
 * style, so the block looked like ours and was tokenised wrong.
 *
 * A second registration, and not through `decorateCooked`, for three reasons.
 *
 *   1. No sweeps. The hook alone covers the preview: it fires for every
 *      re-cook, and there is no "already rendered before install" gap to
 *      close, since the composer opens long after boot.
 *
 *   2. No per-route charging to code-intel. decorate.ts charges every callback
 *      to the module and registry.ts strikes on cumulative cost per route —
 *      and a composer session is one route. A 400-line block re-tokenises in
 *      about 2ms (6.7ms measured for 1,247 lines), so a long draft over a
 *      capped block would accumulate hundreds of ms and strike the module for
 *      answering the author's own typing; three such sessions on consecutive
 *      routes would switch it off. The work is still measured — charged under
 *      `PREVIEW_OWNER`, which `moduleWork()` reports — but there is no budget
 *      under that key, so it cannot strike. That is deliberate: the strike net
 *      exists for pages the extension made slow, not for a draft the author is
 *      choosing to write.
 *
 *   3. Different guard. `data-dfp-code` survives `innerHTML` replacement —
 *      attributes stay, children go — so on a block hljs rewrites after us it
 *      would say "done" over Lua-grammar markup. The preview reads the answer
 *      from the children instead (`isRendered`): a `<code>` is ours while no
 *      element child wears a class other than a `dfp-` one. Re-cooks make new
 *      elements and reset naturally; hljs's asynchronous worker result, which
 *      this build may land before or after the decorator, is caught by a
 *      MutationObserver on the preview and rendered over. That observer sees
 *      this module's own render as a mutation too, so the timer drains its
 *      records after each pass — see `schedulePreview`.
 *
 * Trailing-debounced at 300ms per preview element: Discourse re-cooks on a
 * short debounce of its own, and painting marks a third of a second after the
 * author pauses is indistinguishable from immediate, while re-tokenising on
 * every cook is not. Blocks over PREVIEW_MAX_LINES are left to hljs — a
 * 3,000-line paste must never make typing stutter — and they get the full
 * treatment once posted.
 *
 * Highlight and marks only. No docs anchors (see RenderOptions), no note: the
 * marks carry their own title and data attributes, and a keyboard surface for
 * the preview would sit beside a textarea that already has focus.
 * ───────────────────────────────────────────────────────────────────────── */

const PREVIEW = ".d-editor-preview";
const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_MAX_LINES = 400;
/** Accounting key for preview work: reported by `moduleWork()`, never budgeted. */
const PREVIEW_OWNER = "code-intel:preview";

const previewTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const previewObservers = new WeakMap<HTMLElement, MutationObserver>();

function onPreviewCooked(element: HTMLElement): void {
  const preview = element.closest<HTMLElement>(PREVIEW);
  if (!preview) return;
  watchPreview(preview);
  schedulePreview(preview);
}

function watchPreview(preview: HTMLElement): void {
  if (previewObservers.has(preview)) return;
  const observer = new MutationObserver(() => schedulePreview(preview));
  observer.observe(preview, { childList: true, subtree: true });
  previewObservers.set(preview, observer);
}

/**
 * Called from the timer, not from the observer's own callback. The callback
 * used to check `isConnected` and disconnect — but nothing is ever delivered on
 * a detached subtree: Ember removes the editor's root element whole when the
 * composer closes, and a `childList` observer on the preview never hears about
 * its own removal, so that branch could not run after the one event it was
 * written for. The timer does run after detach whenever a cook landed in the
 * last 300ms. A close with nothing pending keeps its observer until the element
 * is collected, which it can be — an observer holds its target weakly.
 */
function unwatchPreview(preview: HTMLElement): void {
  previewObservers.get(preview)?.disconnect();
  previewObservers.delete(preview);
}

function schedulePreview(preview: HTMLElement): void {
  const pending = previewTimers.get(preview);
  if (pending !== undefined) clearTimeout(pending);
  previewTimers.set(
    preview,
    setTimeout(() => {
      previewTimers.delete(preview);
      if (!preview.isConnected) {
        unwatchPreview(preview);
        return;
      }
      const t0 = performance.now();
      try {
        enhancePreview(preview);
      } catch {
        // A half-typed snippet must never break the composer.
      } finally {
        /* The render just made is itself a childList mutation on the preview.
         * Left queued, the observer would deliver it as a microtask and put
         * another pass 300ms out, whose render would queue another — the loop
         * `isRendered` closes for text-only blocks, closed here for every
         * block. Draining is safe because nothing but this module writes to the
         * preview inside this timer task: what is thrown away is its own work,
         * and a re-cook or an hljs rewrite is a later task that queues afresh. */
        previewObservers.get(preview)?.takeRecords();
        charge(PREVIEW_OWNER, performance.now() - t0);
      }
    }, PREVIEW_DEBOUNCE_MS),
  );
}

/**
 * Is this block still wearing this module's markup? See the section note.
 *
 * "No element child that is not ours", not "the first child is ours". The
 * first-child test said `false` for any block whose render is text only — a
 * lone `myVar`, `foo bar`, the half-typed line an author is in the middle of —
 * because a plain identifier is emitted as a text node and a `<code>` with no
 * element child at all read as hljs's. Each pass then `replaceChildren`'d the
 * same text, a childList mutation the observer turned into another pass 300ms
 * on: a timer loop for as long as the composer was open, waking composer.ts's
 * `#reply-control` observer in the isolated world on every tick and growing
 * `moduleWork()["code-intel:preview"]` without bound. Three passes over such a
 * block rendered [1, 1, 1]. A block hljs rewrote still has `hljs-*` spans and
 * is rendered again; a text-only block converges on its first pass.
 */
function isRendered(code: HTMLElement): boolean {
  if (!code.classList.contains("dfp-luau")) return false;
  for (const child of code.children) {
    if (!child.className.includes("dfp-")) return false;
  }
  return true;
}

function lineCount(source: string): number {
  let n = 1;
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * One pass over a composer preview. Exported for the test; the decorator
 * reaches it through the debounce above. Returns how many blocks it rendered.
 */
export function enhancePreview(root: HTMLElement): number {
  let rendered = 0;
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    if (isRendered(code) || !isLuauBlock(code)) continue;
    if (lineCount(code.textContent ?? "") > PREVIEW_MAX_LINES) continue;
    renderBlock(code, { anchors: false });
    code.classList.add("dfp-luau");
    rendered++;
  }
  return rendered;
}

export function codeIntel(api: PluginApi): DfpModule {
  return {
    id: "code-intel",
    /* A real budget, per route. For most of this file's life it was 12 and
     * measured nothing: registry.ts wrapped `install()` only, and install here
     * is one `decorateCooked` call that reads about 0ms. Two things changed.
     * decorate.ts and dom-watch.ts now charge every decorator pass to the
     * module that registered it, and registry.ts resets the meter — and
     * settles strikes — at each route change, so the number is compared against
     * the tokenizing a whole page of posts actually costs.
     *
     * Sizing: a single large block tokenizes in 6.7ms (measured, see
     * classifyMembers), and a code-heavy Scripting Support window is twenty
     * posts with a block or two each — on the order of 100-150ms of real work
     * per route. 250 leaves that room and still strikes on a pathological
     * page (several multi-thousand-line pastes), which is the case the
     * three-strike net exists for. Left at 12, the module would have disabled
     * itself on the third ordinary code-heavy route after the accounting
     * landed. */
    budgetMs: 250,

    install() {
      /* decorateCooked, not decorateCookedElement: the hook alone misses every
       * post that rendered before DFP installed, which on a hard refresh is the
       * whole first screen. See discourse/decorate.ts. */
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-code-intel",
        onlyStream: true,
      });

      /* The composer preview, through the raw hook and without `onlyStream` —
       * which is what makes Discourse call it for `.d-editor-preview` at all.
       * It is called for every stream post too, and bails on `closest()` in a
       * few hundred nanoseconds. Everything else about why this is not a second
       * `decorateCooked` is in the section note above `enhancePreview`. */
      api.decorateCookedElement((element) => onPreviewCooked(element), {
        id: "dfp-code-intel-preview",
      });
    },
  };
}
