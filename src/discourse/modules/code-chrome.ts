import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { detect, declaredNames, type Finding } from "../../luau/detect";
import { tokenize } from "../../luau/tokenizer";
import { API_INDEX } from "../../luau/api-index.generated";

/**
 * Controls on code blocks: a language label, wrap, collapse, a copy that can
 * drop comments, and a copy that replaces deprecated Luau calls.
 *
 * Discourse already renders its own cluster inside every `<pre>`, verified on
 * the live forum:
 *
 *   <pre>
 *     <div class="codeblock-button-wrapper">
 *       <button class="btn nohighlight copy-cmd btn-flat" title="copy code…">
 *       <button class="btn nohighlight fullscreen-cmd btn-flat" title="show code…">
 *     </div>
 *     <code class="lang-lua hljs language-lua">
 *
 * So this adds to that cluster rather than building a second bar next to it —
 * two rows of controls on one code block would look like a bug, and the wrapper
 * is already positioned correctly.
 *
 * Deliberately not included: line numbers. They need every line wrapped in its
 * own element, which fights both highlight.js's markup and soft wrapping, and
 * they add a permanent gutter of noise to every snippet on the page for a
 * feature that matters only when someone is citing a specific line.
 */

const PROCESSED = "data-dfp-chrome";

/** Blocks longer than this collapse by default. */
const COLLAPSE_LINES = 28;

/** Discourse tags the language on the <code> element as `lang-xxx`. */
function languageOf(code: HTMLElement): string | null {
  const m = /(?:^|\s)lang-([\w+#-]+)/.exec(code.className);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  // The forum has no `luau` entry in `highlighted_languages`, so genuine Luau
  // arrives tagged `lua`. If code-intel re-tokenised it, say what it really is.
  if (code.classList.contains("dfp-luau")) return "luau";
  const pretty: Record<string, string> = {
    lua: "lua",
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "shell",
    bash: "shell",
  };
  return pretty[raw] ?? raw;
}

function button(label: string, title: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-flat nohighlight dfp-code-btn ${cls}`;
  b.textContent = label;
  b.title = title;
  return b;
}

/**
 * Strip comments for "copy without comments".
 *
 * Line comments only, and only when the `--` is not inside a string. Block
 * comments are left alone: they usually carry the explanation someone actually
 * wanted to keep, and removing them from a copied snippet is the kind of
 * surprise that makes a feature untrustworthy.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    let quote: string | null = null;
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "-" && line[i + 1] === "-") {
        cut = i;
        break;
      }
    }
    const kept = cut === -1 ? line : line.slice(0, cut).trimEnd();
    // A line that was nothing but a comment disappears rather than becoming a
    // blank one, so the copied snippet does not gain gaps.
    if (cut !== -1 && kept.trim() === "") continue;
    out.push(kept);
  }
  return out.join("\n");
}

/* ── Copy with fixes ───────────────────────────────────────────────────────
 *
 * code-intel already underlines deprecated calls and says what to use instead.
 * This turns that into something you can act on — but it is the one control in
 * the cluster that hands back characters the author never wrote, and it is
 * aimed at a script window in Roblox Studio. So the bar is not "the finding
 * says this is deprecated", it is "these characters can become those characters
 * and the code still means what it meant".
 *
 * One rule decides it, and both halves have to hold:
 *
 *   1. SHAPE. The replacement has to be spellable in the slot the finding
 *      occupies — `:Connect()` for a method, `.ClassName` for a property, a
 *      plain or dotted name for a global. `GetMouse` → "UserInputService" and
 *      `LoadAnimation` → "Animator:LoadAnimation()" are advice rather than
 *      substitutions; dropped into the span they occupy they would produce
 *      `player:UserInputService()` and `humanoid:Animator:LoadAnimation()`.
 *
 *   2. IDENTITY. The last name in the replacement has to be the matched name in
 *      different casing. That is what makes it a rename of the SAME operation
 *      rather than a migration to a different one.
 *
 * Rule 2 is the load-bearing half, and it is what rejects the findings that
 * look mechanical and are not:
 *
 *   `:remove()` → `:Destroy()`   A different function. `remove` reparents to
 *      nil and the instance stays alive, which is the old "take it away and put
 *      it back later" idiom; `Destroy` locks the Parent, so a `tool.Parent =
 *      backpack` further down the same snippet starts erroring.
 *
 *   `BodyVelocity` → `LinearVelocity`   A different object. The constraint
 *      movers are not renames: LinearVelocity does nothing without an
 *      Attachment0 and spells its velocity `VectorVelocity`, so swapping the
 *      class name alone leaves a mover wired to nothing and a `.Velocity =`
 *      that errors. Every class entry in the index is a "superseded by" of that
 *      kind, so `kind === "class"` is skipped outright rather than filtered.
 *
 *   `Instance.new(…, parent)`   Not a substitution at all. The finding spans a
 *      trailing argument that has to be DELETED and re-expressed as a
 *      `.Parent =` assignment on a later line, which needs a name the statement
 *      may not have — `Instance.new("Part", workspace)` standing alone binds
 *      nothing. Deleting the argument on its own would quietly stop parenting
 *      the instance, which is worse than leaving the code as it was.
 *
 *   `ypcall` → `pcall`   Genuinely the same function, but nothing here can
 *      prove that from the index, and the rule does not get an exception list.
 *      A missing fix is the correct failure mode.
 *
 * What survives is the legacy-casing aliases — `:connect()`, `:destroy()`,
 * `.className` and the rest, which resolve to the very member they are renamed
 * to — and the scheduler globals `wait`, `spawn`, `delay` and their capitalised
 * spellings, where `task.*` takes the same arguments in the same order.
 */

/** A replacement this module is willing to make, and the span it applies to. */
export interface CodeFix {
  start: number;
  end: number;
  /** The characters at `[start, end)` today. */
  from: string;
  /** What they become. */
  to: string;
}

/**
 * Every name that could possibly begin a fixable finding, as one test.
 *
 * `detect()` is the expensive half of this feature and most blocks cannot
 * produce a fix at all. Benchmarked on this repo's own `detect`: an 82-line
 * block costs 0.082ms to scan and 0.0011ms to reject here; a 1,216-line one,
 * 1.27ms against 0.0135ms. That is main-thread work inside the window
 * discourse/decorate.ts describes, where Ember is still painting the first
 * screen — and code-intel is already tokenizing every one of these blocks.
 *
 * Conservative by construction, which is the only reason a shortcut around the
 * tokenizer is allowed here at all: a global or member finding is always a
 * token whose value IS one of these keys, so a block none of them appear in has
 * no fix to miss. Class and pattern findings are never fixable, so the class
 * names are deliberately absent — including them would defeat the whole gate,
 * since `Part` and `Sound` appear in nearly every snippet on the forum.
 */
const FIXABLE_NAME = new RegExp(
  `\\b(?:${[...Object.keys(API_INDEX.globals), ...Object.keys(API_INDEX.members)].join("|")})\\b`,
);

/** The same identifier in different casing — an alias, not a different API. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The exact characters this finding's span must become, or null if it is not a
 * safe mechanical swap. The rule, and what it rejects, is above.
 *
 * `shadows` answers "did this snippet declare that name itself". Two things
 * need it, both on the global arm: `task.wait` is not the answer in a block
 * that opens `for _, task in pairs(queue)`, and a block that says
 * `local wait = customWait` on line 1 and `wait(2)` on line 9 is calling its
 * own function — detect() only checks for `local` immediately before the token,
 * so that second call still arrives here as a finding.
 */
function fixText(f: Finding, shadows: (name: string) => boolean): string | null {
  const replacement = f.entry.replacement;
  if (!replacement) return null;

  if (f.kind === "member") {
    /* The sigil is required, and it is not redundant with the access field:
     * detect() has already dropped a `method` entry found after `.` and a
     * `property` entry found after `:`, so asking the replacement to carry the
     * matching sigil is asking the entry to describe the slot the finding is
     * actually sitting in. An entry with no access at all cannot answer that,
     * and gets nothing. */
    const shape =
      f.entry.access === "method"
        ? /^:([A-Za-z_]\w*)\(\)$/.exec(replacement)
        : f.entry.access === "property"
          ? /^\.([A-Za-z_]\w*)$/.exec(replacement)
          : null;
    const name = shape?.[1];
    return name && sameName(name, f.text) ? name : null;
  }

  if (f.kind === "global") {
    // `task.wait()` — a dotted path, optionally written as a call.
    const path = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\(\))?$/.exec(replacement)?.[1];
    if (!path) return null;
    const segments = path.split(".");
    if (!sameName(segments[segments.length - 1]!, f.text)) return null;
    if (shadows(f.text) || shadows(segments[0]!)) return null;
    return path;
  }

  // "class" and "pattern" are migrations rather than renames. See above.
  return null;
}

/** Every safely-applicable fix in a Luau snippet, in source order. */
export function luauFixes(source: string): CodeFix[] {
  if (!FIXABLE_NAME.test(source)) return [];

  /* Deferred, and memoised: `declaredNames` needs a tokenizer pass of its own,
   * and it is consulted only by the global arm. A block whose only findings are
   * casing aliases never pays for it. */
  let declared: Set<string> | null = null;
  const shadows = (name: string): boolean => {
    if (!declared) declared = declaredNames(tokenize(source));
    return declared.has(name);
  };

  const fixes: CodeFix[] = [];
  for (const finding of detect(source)) {
    const to = fixText(finding, shadows);
    if (to === null) continue;
    /* `from` is sliced out of the source rather than taken from `finding.text`.
     * They agree for both kinds handled above, but the span is what actually
     * gets replaced, so the label has to be read from the same place. */
    fixes.push({
      start: finding.start,
      end: finding.end,
      from: source.slice(finding.start, finding.end),
      to,
    });
  }
  return fixes;
}

/**
 * Apply the fixes to the source.
 *
 * Back to front, so every offset still indexes the string it was measured
 * against: `wait` → `task.wait` changes the length of the text at the very
 * first span, and a forward walk would leave every later one pointing four
 * characters short. `detect()` returns findings sorted by `start` and already
 * merged so that none overlaps another, which is what makes a plain reverse
 * walk sufficient rather than an interval merge.
 */
export function applyFixes(source: string, fixes: readonly CodeFix[]): string {
  let out = source;
  for (let i = fixes.length - 1; i >= 0; i--) {
    const fix = fixes[i]!;
    out = out.slice(0, fix.start) + fix.to + out.slice(fix.end);
  }
  return out;
}

/**
 * What the button will change, named rather than counted.
 *
 * The same shape code-intel's `addSummary` arrived at, for the same reason: a
 * block can carry a dozen findings that are all one idiom, and "12" is a number
 * nobody can check. Three spelled-out substitutions fit in a tooltip and let
 * someone decide before they paste rather than after.
 */
function summarise(fixes: readonly CodeFix[]): string {
  const groups = new Map<string, number>();
  for (const fix of fixes) {
    const label = `${fix.from} → ${fix.to}`;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const parts = [...groups]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  const hidden = groups.size - parts.length;
  if (hidden > 0) parts.push(`+${hidden} more`);
  return parts.join(", ");
}

/**
 * Is this block Luau?
 *
 * `.dfp-luau` is code-intel's own answer, set on exactly the blocks it
 * re-tokenised — including the unfenced ones it accepted on structure alone —
 * so it is checked first and trusted outright.
 *
 * But nothing orders the two modules. Both register through `decorateCooked`,
 * so both ride the same microtask/rAF/400ms/1500ms schedule and Discourse's own
 * decorator chain, and this module marks a `<pre>` PROCESSED the first time it
 * finds a button wrapper to attach to — which can be before code-intel has
 * looked at that block at all. Hence a fallback, and deliberately only the half
 * of code-intel's test that is certain: a `lang-lua`/`lang-luau` fence, which
 * code-intel accepts unconditionally too.
 *
 * Its heuristic for UNFENCED blocks is not duplicated here. That is forty lines
 * of regex tuned against a corpus, it is private to code-intel, and a second
 * copy would drift — so an unfenced block this module reaches first gets no fix
 * button. A missing button is the right failure. A copy that rewrote a shell
 * transcript because a local heuristic disagreed with the real one is not.
 */
function looksLuau(code: HTMLElement): boolean {
  if (code.classList.contains("dfp-luau")) return true;
  return /(?:^|\s)lang-(?:lua|luau)\b/.test(code.className);
}

async function copy(text: string, btn: HTMLButtonElement, done: string): Promise<void> {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = done;
  } catch {
    // Clipboard can be denied by permissions policy; say so rather than
    // pretending it worked.
    btn.textContent = "failed";
  }
  setTimeout(() => {
    btn.textContent = original;
  }, 1400);
}

function enhance(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    if (pre.hasAttribute(PROCESSED)) continue;
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) continue;

    const wrapper = pre.querySelector<HTMLElement>(".codeblock-button-wrapper");
    // No wrapper means Discourse has not treated this as a code block *yet* —
    // its own copy-codeblocks decorator adds that element, and the sweep is not
    // ordered against Discourse's decorator chain. Bail WITHOUT marking, so a
    // later pass can finish the job.
    if (!wrapper) continue;

    /* Marked only once there is something to attach to. The attribute used to
     * be set above this check, which made it mean "looked at once": a sweep
     * arriving one tick before Discourse wrapped the block latched a false
     * negative that the rAF/400ms/1500ms retries then skipped, permanently. */
    pre.setAttribute(PROCESSED, "1");

    const source = code.textContent ?? "";
    const lines = source.split("\n").length;

    // Controls read left to right as: label, then ours, then Discourse's.
    // Tracked explicitly because everything below inserts at the front, and
    // prepending twice would put the label after the button it labels.
    let lead: ChildNode | null = wrapper.firstChild;
    const prepend = (el: HTMLElement) => wrapper.insertBefore(el, lead);

    // ── Language label ───────────────────────────────────────────────────
    const lang = languageOf(code);
    if (lang) {
      const tag = document.createElement("span");
      tag.className = "dfp-code-lang";
      tag.textContent = lang;
      prepend(tag);
    }

    // ── Wrap ─────────────────────────────────────────────────────────────
    // Only offered when a line is long enough to run off the edge; a wrap
    // toggle on a block that already fits is a button that appears to do
    // nothing.
    //
    // Measured from the source rather than from `scrollWidth`, because this
    // decorator can run before the element is laid out — geometry would read 0
    // and the button would never appear.
    const longest = source.split("\n").reduce((n, l) => Math.max(n, l.length), 0);
    if (longest > 96) {
      const wrap = button("wrap", "Toggle soft wrapping", "dfp-code-wrap");
      wrap.setAttribute("aria-pressed", "false");
      wrap.addEventListener("click", () => {
        const on = pre.classList.toggle("dfp-code--wrapped");
        wrap.setAttribute("aria-pressed", String(on));
      });
      prepend(wrap);
    }

    // ── Copy without comments ────────────────────────────────────────────
    // Next to Discourse's own copy, which already copies the code correctly.
    // Only where it would change anything.
    const stripped = stripComments(source);
    if (stripped !== source && stripped.trim() !== "") {
      /* Named for what it does, not for what it produces. "copy bare" read as
       * jargon next to Discourse's own copy button and gave no clue how the two
       * differed — which is the only thing a second copy button has to say. */
      const bare = button(
        "copy without comments",
        "Copy the code with comment lines removed",
        "dfp-code-bare",
      );
      bare.addEventListener("click", () => void copy(stripped, bare, "copied"));
      // Immediately before Discourse's copy, so the copies sit together.
      prepend(bare);
    }

    // ── Copy with fixes ──────────────────────────────────────────────────
    // Last of ours, so the three copies sit in a row ending at Discourse's own.
    //
    // The count is in the label rather than in a tooltip, because "copy with
    // fixes" on a block where nothing safely applies would be a claim about
    // somebody else's code that this module cannot back. No fixes, no button.
    const fixes = looksLuau(code) ? luauFixes(source) : [];
    if (fixes.length > 0) {
      const n = fixes.length;
      const fixed = button(
        `copy with ${n} fix${n === 1 ? "" : "es"}`,
        `Copy with deprecated APIs replaced — ${summarise(fixes)}`,
        "dfp-code-fix",
      );
      /* Rewritten on click, not now. Only someone who presses the button wants
       * the string, and holding a second copy of every code block on the page
       * for the life of the page buys nothing. */
      fixed.addEventListener("click", () =>
        void copy(applyFixes(source, fixes), fixed, `copied · ${n} replaced`),
      );
      prepend(fixed);
    }

    // ── Collapse long blocks ─────────────────────────────────────────────
    // A 300-line paste should not push the rest of the thread off the screen.
    if (lines > COLLAPSE_LINES) {
      pre.classList.add("dfp-code--clipped");
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "dfp-code-expand";
      expand.textContent = `Show all ${lines} lines`;
      expand.addEventListener("click", () => {
        const clipped = pre.classList.toggle("dfp-code--clipped");
        expand.textContent = clipped ? `Show all ${lines} lines` : "Collapse";
        if (clipped) pre.scrollIntoView({ block: "nearest" });
      });
      pre.after(expand);
    }
  }
}

export function codeChrome(api: PluginApi): DfpModule {
  return {
    id: "code-chrome",
    budgetMs: 120,

    install() {
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-code-chrome",
        onlyStream: true,
      });
    },
  };
}
