import { API_INDEX, deprecatedOn, type ApiEntry } from "./api-index.generated";
import { tokenize, type Token } from "./tokenizer";

/**
 * Find deprecated API usage in a Luau snippet.
 *
 * Everything here works on the token stream, never on raw text, because the
 * whole value of the feature is not crying wolf. `wait` inside a comment,
 * inside a string, or as someone's own table key is not a finding, and a regex
 * cannot tell the difference.
 *
 * Presentation is advisory by design (see the module that renders these): a
 * mark and an explanation, never a blocking overlay on someone else's post.
 */

export interface Finding {
  /** Character offsets into the original source. */
  start: number;
  end: number;
  /** The text that was matched, e.g. "wait" or "BodyVelocity". */
  text: string;
  kind: "global" | "member" | "class" | "pattern";
  entry: ApiEntry;
}

/** Previous significant token, skipping trivia. */
function prevSignificant(tokens: Token[], i: number): Token | null {
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.kind !== "whitespace" && t.kind !== "comment") return t;
  }
  return null;
}

function nextSignificant(tokens: Token[], i: number): Token | null {
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind !== "whitespace" && t.kind !== "comment") return t;
  }
  return null;
}

/** Strip one layer of quotes from a string token. */
function stringValue(token: Token): string {
  const v = token.value;
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'" || v[0] === "`")) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Globals whose class is fixed by the engine, so no inference is needed.
 * `game.Workspace` and the bare `workspace` are the same object.
 */
export const GLOBAL_TYPES: Record<string, string> = {
  game: "DataModel",
  workspace: "Workspace",
  Workspace: "Workspace",
  script: "Script",
};

/**
 * Guess the class of each local, so a member can be checked against the class
 * that actually declares it rather than against every class at once.
 *
 * Deliberately shallow. It resolves the two forms that account for nearly all
 * receivers in forum code:
 *
 *     local part = Instance.new("Part")
 *     local rs   = game:GetService("RunService")
 *
 * and nothing else. It does not follow `.Parent`, function returns, or table
 * fields. A receiver it cannot resolve yields no dump-derived finding — that is
 * the point. Guessing wrong here means underlining correct code in someone
 * else's post, which costs more than the finding was worth.
 */
export function inferLocalTypes(tokens: Token[]): Map<string, string> {
  const types = new Map<string, string>();

  const sig = (from: number): { tok: Token; i: number } | null => {
    for (let j = from; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.kind !== "whitespace" && t.kind !== "comment") return { tok: t, i: j };
    }
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "keyword" || t.value !== "local") continue;

    const name = sig(i + 1);
    if (!name || name.tok.kind !== "ident") continue;
    const eq = sig(name.i + 1);
    if (!eq || eq.tok.value !== "=") continue;

    const head = sig(eq.i + 1);
    if (!head) continue;

    // Instance.new("ClassName") / game:GetService("ClassName") share a shape:
    //   <ident> <.|:> <ident> ( "<string>"
    const dot = sig(head.i + 1);
    if (!dot || (dot.tok.value !== "." && dot.tok.value !== ":")) continue;
    const fn = sig(dot.i + 1);
    if (!fn) continue;

    const isNew = head.tok.value === "Instance" && fn.tok.value === "new";
    const isService =
      fn.tok.value === "GetService" && GLOBAL_TYPES[head.tok.value] === "DataModel";
    if (!isNew && !isService) continue;

    const paren = sig(fn.i + 1);
    if (!paren || paren.tok.value !== "(") continue;
    const arg = sig(paren.i + 1);
    if (!arg || arg.tok.kind !== "string") continue;

    types.set(name.tok.value, stringValue(arg.tok));
  }

  return types;
}

/**
 * Is the identifier at `i` naming a type rather than a value?
 *
 * Two unambiguous forms, and nothing else:
 *
 *     local part :: BodyVelocity      -- a cast
 *     local part: BodyVelocity = …    -- an annotation
 *
 * The annotation case has to be told apart from a method call, which also puts
 * an identifier after `:`. The difference is what precedes the receiver:
 * `local x: T` has a declaration keyword behind it, `obj:method()` does not.
 */
function isTypePosition(tokens: Token[], i: number, prev: Token): boolean {
  if (prev.kind === "operator" && prev.value === "::") return true;
  if (prev.value !== ":") return false;

  const name = prevSignificant(tokens, tokens.indexOf(prev));
  if (!name || name.kind !== "ident") return false;
  const decl = prevSignificant(tokens, tokens.indexOf(name));
  if (!decl) return false;
  // `local x: T`, and the parameter forms `function f(x: T)` / `(a, x: T)`.
  return (
    (decl.kind === "keyword" && decl.value === "local") ||
    decl.value === "(" ||
    decl.value === ","
  );
}

/**
 * Is the member at `i` being *defined* rather than called?
 *
 * `function ragdoll:destroy()` is somebody writing their own method that happens
 * to share a name with a legacy alias. Marking it deprecated tells them their
 * own API is wrong. Walks back through any dotted path — `function a.b.c:m()` —
 * to see whether the chain starts at `function`.
 */
function isDefinitionSite(tokens: Token[], i: number): boolean {
  let cursor: Token | null = tokens[i]!;
  // Alternate <ident> <. or :> going left, up to a few segments.
  for (let hops = 0; cursor && hops < 8; hops++) {
    const sep: Token | null = prevSignificant(tokens, tokens.indexOf(cursor));
    if (!sep || (sep.value !== "." && sep.value !== ":")) return false;
    const owner: Token | null = prevSignificant(tokens, tokens.indexOf(sep));
    if (!owner) return false;
    const before: Token | null = prevSignificant(tokens, tokens.indexOf(owner));
    if (before?.kind === "keyword" && before.value === "function") return true;
    if (!before || (before.value !== "." && before.value !== ":")) return false;
    cursor = owner;
  }
  return false;
}

/**
 * Method names the snippet defines for itself.
 *
 * If a block contains `function ragdoll:destroy()`, then `self:destroy()` later
 * in that same block is a call into the author's own class, not the legacy
 * `:destroy()` alias. The definition is right there in the text, so there is no
 * excuse for getting it wrong.
 */
function locallyDefined(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "ident") continue;
    if (isDefinitionSite(tokens, i)) names.add(t.value);
  }
  return names;
}

export function detect(source: string): Finding[] {
  const tokens = tokenize(source);
  const findings: Finding[] = [];
  const localTypes = inferLocalTypes(tokens);
  const ownMethods = locallyDefined(tokens);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    // Only identifiers and builtins can name an API. Comments and strings are
    // skipped implicitly by never being considered here — except for the
    // Instance.new("ClassName") case handled below, which reads the string
    // deliberately.
    if (t.kind !== "ident" && t.kind !== "builtin") continue;

    const prev = prevSignificant(tokens, i);
    const next = nextSignificant(tokens, i);
    const afterDot = prev?.kind === "punct" && (prev.value === "." || prev.value === ":");

    // ── Class names in type position ─────────────────────────────────────
    // Checked before members, because `local bv: BodyVelocity` also puts an
    // identifier after a colon and would otherwise be read as a method call.
    //
    // Only in type position. An earlier version flagged any bare identifier
    // matching a deprecated class, and on a real corpus that fired mostly on
    // variable names: `local Skin = Instance.new("StringValue", …)` was marked
    // because `Skin` happens to be a deprecated class. A name is not a use.
    const asType = (API_INDEX.classes as Record<string, ApiEntry>)[t.value];
    if (asType && prev && isTypePosition(tokens, i, prev)) {
      findings.push({ start: t.start, end: t.end, text: t.value, kind: "class", entry: asType });
      continue;
    }

    // ── Members: only after `.` or `:` ───────────────────────────────────
    if (afterDot) {
      // `function ragdoll:destroy()` defines a method, it does not call one —
      // and once defined, every call to it in this block is the author's own.
      if (isDefinitionSite(tokens, i) || ownMethods.has(t.value)) continue;

      // `:` is a method call, `.` is a field read. Several legacy aliases share
      // a name with a modern API that differs only in access form —
      // `event:wait()` is deprecated, `task.wait()` is the correct answer — so
      // flagging by name alone would call the right code wrong.
      const isMethod = prev.value === ":";
      const receiver = prevSignificant(tokens, tokens.indexOf(prev));
      const receiverName = receiver?.value ?? "";

      // Two sources, in order of confidence.
      //
      // 1. The curated alias list, matched on any receiver. Safe because every
      //    entry is a lowercase legacy spelling with no current counterpart.
      // 2. The dump, but only once the receiver's class is known, and only if
      //    the member is deprecated on that class or an ancestor. An
      //    unresolvable receiver gets nothing rather than a guess.
      let entry = (API_INDEX.members as Record<string, ApiEntry>)[t.value];
      if (!entry && receiver) {
        const cls = localTypes.get(receiverName) ?? GLOBAL_TYPES[receiverName];
        if (cls) entry = deprecatedOn(cls, t.value) ?? undefined!;
      }

      if (entry) {
        if (entry.access === "method" && !isMethod) continue;
        if (entry.access === "property" && isMethod) continue;
        // Some members are only deprecated on a particular receiver —
        // `LoadAnimation` is fine on an Animator and deprecated on a Humanoid.
        // The name is all we have when inference failed, so match on it.
        if (entry.onlyAfter) {
          const matches = entry.onlyAfter.some((r) =>
            receiverName.toLowerCase().includes(r.toLowerCase()),
          );
          if (!matches) continue;
        }
        findings.push({ start: t.start, end: t.end, text: t.value, kind: "member", entry });
      }
      continue;
    }

    // ── Globals: bare calls only ─────────────────────────────────────────
    // `wait(…)` is a finding; `myTable.wait` is not (handled above), and
    // `local wait = …` is a shadow, not a use.
    const entry = (API_INDEX.globals as Record<string, ApiEntry>)[t.value];
    if (entry) {
      const isCall = next?.kind === "punct" && (next.value === "(" || next.value === "{");
      const isShadowed = prev?.kind === "keyword" && prev.value === "local";
      const isAssignedTo =
        next?.kind === "operator" && next.value === "=" && prev?.value !== "==";
      if (isCall && !isShadowed && !isAssignedTo) {
        findings.push({ start: t.start, end: t.end, text: t.value, kind: "global", entry });
      }
      continue;
    }

    // ── Classes inside Instance.new("…") ─────────────────────────────────
    if (t.value === "Instance") {
      const dot = nextSignificant(tokens, i);
      if (dot?.value !== ".") continue;
      const nw = nextSignificant(tokens, tokens.indexOf(dot));
      if (nw?.value !== "new") continue;
      const paren = nextSignificant(tokens, tokens.indexOf(nw));
      if (paren?.value !== "(") continue;
      const arg = nextSignificant(tokens, tokens.indexOf(paren));
      if (!arg || arg.kind !== "string") continue;

      const className = stringValue(arg);
      const classEntry = (API_INDEX.classes as Record<string, ApiEntry>)[className];
      if (classEntry) {
        findings.push({
          start: arg.start,
          end: arg.end,
          text: className,
          kind: "class",
          entry: classEntry,
        });
      }

      // The two-argument form parents before properties are set, so the engine
      // replicates every subsequent assignment separately.
      const afterArg = nextSignificant(tokens, tokens.indexOf(arg));
      if (afterArg?.value === ",") {
        // Span the whole `, parent` argument, not just the comma. A wavy
        // underline four pixels wide is not a finding anyone will notice, and
        // the argument is what has to be deleted.
        let depth = 0;
        let end = afterArg.end;
        for (let j = tokens.indexOf(afterArg); j < tokens.length; j++) {
          const tk = tokens[j]!;
          if (tk.value === "(") depth++;
          else if (tk.value === ")") {
            if (depth === 0) break;
            depth--;
          }
          if (tk.kind !== "whitespace") end = tk.end;
        }
        const p = API_INDEX.patterns.instanceNewParent;
        findings.push({
          start: afterArg.start,
          end,
          text: "Instance.new(…, parent)",
          kind: "pattern",
          entry: { replacement: p.replacement, severity: p.severity, why: p.why },
        });
      }
      continue;
    }

  }

  // Overlapping findings would produce nested marks; keep the first at each
  // position and drop anything that starts inside it.
  findings.sort((a, b) => a.start - b.start);
  const merged: Finding[] = [];
  let lastEnd = -1;
  for (const f of findings) {
    if (f.start >= lastEnd) {
      merged.push(f);
      lastEnd = f.end;
    }
  }
  return merged;
}
