import { API_INDEX, deprecatedOn, type ApiEntry } from "./api-index.generated";
import { tokenize, type Token } from "./tokenizer";
import { memberType, eventParamTypes } from "./member-types.generated";

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
 * Functions whose string argument IS the class of what they return.
 *
 * Exact only. The engine resolves each of these by class, so the argument is a
 * type and there is nothing else it could be.
 *
 * `FindFirstChild("Humanoid")` and `WaitForChild("Humanoid")` are deliberately
 * NOT here. They resolve by *name*: the argument is whatever the author called
 * the instance, and a part named "Humanoid" is a part. Typing from them links
 * roughly-usually-correctly, which is the worst thing an annotation like this
 * can be — a reader cannot tell the confident links from the lucky ones, so the
 * confident ones stop being worth anything. If it is not provable, it does not
 * get underlined.
 */
const CLASS_TYPED_CALLS = new Set([
  "FindFirstChildOfClass",
  "FindFirstChildWhichIsA",
  "FindFirstAncestorOfClass",
  "FindFirstAncestorWhichIsA",
]);

/** Statement keywords that end the right-hand side we are willing to scan. */
const STOPS = new Set(["local", "if", "then", "end", "return", "while", "for", "function", "do"]);

/**
 * Guess the class of each local, so a member can be checked against the class
 * that actually declares it rather than against every class at once.
 *
 * Deliberately shallow, but no longer as shallow as two shapes. It resolves:
 *
 *     local part = Instance.new("Part")
 *     local rs   = game:GetService("RunService")
 *     local hum  = char:FindFirstChildOfClass("Humanoid")
 *     local hum: Humanoid = …                             -- the author said so
 *
 * The chained form matters more than it looks: the earlier version only checked
 * the token immediately after `=`, so `otherpart.Parent:FindFirstChild("X")`
 * — a receiver reached through one hop, which is most real code — resolved to
 * nothing at all, and every member on that local stayed unlinked.
 *
 * It still does not follow `.Parent`, plain function returns, or table fields.
 * A receiver it cannot resolve yields no dump-derived finding — that is the
 * point. Guessing wrong here means underlining correct code in someone else's
 * post, which costs more than the finding was worth.
 *
 * Everything returned here is validated by the caller against the real docs
 * name sets, so an unknown or misspelled class simply never links.
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

    /* `local hum: Humanoid = …`. An annotation outranks anything inferred from
     * the right-hand side, because the author stated it outright. Told apart
     * from `local x = a:b()` by the colon sitting directly after the name. */
    const colon = sig(name.i + 1);
    if (colon && colon.tok.value === ":") {
      const ann = sig(colon.i + 1);
      if (ann && (ann.tok.kind === "ident" || ann.tok.kind === "builtin")) {
        types.set(name.tok.value, ann.tok.value);
        continue;
      }
    }

    const eq = sig(name.i + 1);
    if (!eq || eq.tok.value !== "=") continue;

    /* Walk the right-hand side for `<.|:> <fn> ( "<string>"`, rather than only
     * looking immediately after `=`. That is what lets a receiver reached
     * through a hop resolve — `otherpart.Parent:FindFirstChild("Humanoid")` —
     * where before only a call sitting flush against `=` was ever seen.
     *
     * Bounded by the next statement keyword so this never runs away down the
     * file, and by a token budget for pathological one-liners. */
    let j = eq.i + 1;
    let budget = 24;
    while (budget-- > 0) {
      const step = sig(j);
      if (!step) break;
      if (step.tok.kind === "keyword" && STOPS.has(step.tok.value)) break;

      const sep = step.tok.value;
      if (sep !== "." && sep !== ":") {
        j = step.i + 1;
        continue;
      }

      const fn = sig(step.i + 1);
      if (!fn) break;
      const paren = sig(fn.i + 1);
      const arg = paren && paren.tok.value === "(" ? sig(paren.i + 1) : null;
      if (!arg || arg.tok.kind !== "string") {
        j = fn.i + 1;
        continue;
      }

      const recvName = recvValue(tokens, step.i);
      const fnName = fn.tok.value;

      const isNew = recvName === "Instance" && fnName === "new";
      const isService = fnName === "GetService" && GLOBAL_TYPES[recvName ?? ""] === "DataModel";

      if (isNew || isService || CLASS_TYPED_CALLS.has(fnName)) {
        types.set(name.tok.value, stringValue(arg.tok));
        break;
      }

      j = fn.i + 1;
    }
  }

  /* Second phase: propagate through member chains and event handlers.
   *
   * Run to a fixed point rather than once, because these feed each other — a
   * service resolves a local, the local's property resolves another local, and
   * a handler bound off that one names its parameter. Three passes covers the
   * depth real forum snippets reach; the loop exits early once nothing changed,
   * so the common case costs one extra walk. */
  for (let pass = 0; pass < 3; pass++) {
    const before = types.size;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind !== "keyword" || t.value !== "local") continue;
      const name = nextSignificantFrom(tokens, i + 1);
      if (!name || name.tok.kind !== "ident" || types.has(name.tok.value)) continue;
      const eq = nextSignificantFrom(tokens, name.i + 1);
      if (!eq || eq.tok.value !== "=") continue;
      const head = nextSignificantFrom(tokens, eq.i + 1);
      if (!head) continue;

      const chain = chainType(tokens, head.i, types);
      // Only when the chain actually stepped through a member — a bare
      // `local a = b` alias is not what this is for.
      if (chain && chain.end > head.i) types.set(name.tok.value, chain.type);
    }

    bindEventParams(tokens, types);

    if (types.size === before) break;
  }

  return types;
}

/**
 * The type of a dotted chain starting at token `i`, e.g. `localPlayer.Character`.
 *
 * Walks one hop at a time through the generated member table, so every step is
 * a fact Roblox published rather than a guess. Stops at the first hop it cannot
 * prove, which is what keeps `folder.MyThing` — someone's own child, named
 * whatever they liked — from resolving to anything.
 *
 * Returns the type and the index of the last token consumed, so a caller can
 * tell how much of the expression was accounted for.
 */
function chainType(
  tokens: Token[],
  i: number,
  types: Map<string, string>,
): { type: string; end: number } | null {
  const head = tokens[i];
  if (!head || (head.kind !== "ident" && head.kind !== "builtin")) return null;

  let current = types.get(head.value) ?? GLOBAL_TYPES[head.value];
  if (!current) return null;

  let end = i;
  let j = i + 1;
  for (;;) {
    const sep = nextSignificantFrom(tokens, j);
    if (!sep || (sep.tok.value !== "." && sep.tok.value !== ":")) break;
    const member = nextSignificantFrom(tokens, sep.i + 1);
    if (!member || (member.tok.kind !== "ident" && member.tok.kind !== "builtin")) break;

    const next = memberType(current, member.tok.value);
    if (!next) break;
    current = next;
    end = member.i;
    j = member.i + 1;
  }

  return { type: current, end };
}

/**
 * The type of the expression sitting immediately before the `.`/`:` at `sepIdx`.
 *
 * Two shapes, because those are the two that appear:
 *
 *     userInputService.InputBegan          -- a named local or global
 *     game:GetService("UserInputService")  -- an inline call, used directly
 *          .InputBegan
 *
 * The second is extremely common in forum snippets, where people paste a single
 * statement rather than a script with its services hoisted. Without it the whole
 * chain after the closing paren resolved to nothing.
 */
export function exprTypeBefore(
  tokens: Token[],
  sepIdx: number,
  types: Map<string, string>,
): string | undefined {
  let j = sepIdx - 1;
  while (j >= 0 && (tokens[j]!.kind === "whitespace" || tokens[j]!.kind === "comment")) j--;
  const prev = tokens[j];
  if (!prev) return undefined;

  if (prev.kind === "ident" || prev.kind === "builtin") {
    return types.get(prev.value) ?? GLOBAL_TYPES[prev.value];
  }

  // A call expression: walk back over the balanced parens to its callee.
  if (prev.value !== ")") return undefined;
  let depth = 0;
  let k = j;
  for (; k >= 0; k--) {
    const v = tokens[k]!.value;
    if (tokens[k]!.kind === "string") continue;
    if (v === ")") depth++;
    else if (v === "(") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (k < 0) return undefined;

  const arg = nextSignificantFrom(tokens, k + 1);
  const fn = prevSignificant(tokens, k);
  if (!arg || !fn || arg.tok.kind !== "string") return undefined;

  const sep = prevSignificant(tokens, tokens.indexOf(fn));
  const recv = sep ? prevSignificant(tokens, tokens.indexOf(sep)) : null;
  const recvType = recv ? (types.get(recv.value) ?? GLOBAL_TYPES[recv.value]) : undefined;

  const isService = fn.value === "GetService" && recvType === "DataModel";
  const isNew = fn.value === "new" && recv?.value === "Instance";
  if (isService || isNew || CLASS_TYPED_CALLS.has(fn.value)) return stringValue(arg.tok);
  return undefined;
}

/** First significant token at or after `from`. */
function nextSignificantFrom(tokens: Token[], from: number): { tok: Token; i: number } | null {
  for (let j = from; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind !== "whitespace" && t.kind !== "comment") return { tok: t, i: j };
  }
  return null;
}

/**
 * Bind callback parameters from the event they are connected to.
 *
 * `uis.InputBegan:Connect(function(input, gameProcessedEvent)` declares, in
 * Roblox's own data, that the first parameter is an `InputObject`. That is the
 * difference between `input.KeyCode` linking and staying grey, and it is the
 * single most common shape in forum code after `GetService`.
 *
 * Only `Connect`, `Once` and `ConnectParallel` — the three that take a handler
 * whose parameters the event defines. `Wait` returns them instead.
 */
const CONNECTORS = new Set(["Connect", "Once", "ConnectParallel"]);

function bindEventParams(tokens: Token[], types: Map<string, string>): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "ident" || !CONNECTORS.has(t.value)) continue;

    // `<chain>.Event : Connect ( function ( p1, p2 )`
    const colon = prevSignificant(tokens, i);
    if (!colon || (colon.value !== ":" && colon.value !== ".")) continue;
    const evt = prevSignificant(tokens, tokens.indexOf(colon));
    if (!evt || (evt.kind !== "ident" && evt.kind !== "builtin")) continue;

    // The receiver is whatever chain sits before the event name.
    const evtPos = tokens.indexOf(evt);
    const sep2 = prevSignificant(tokens, evtPos);
    if (!sep2 || (sep2.value !== "." && sep2.value !== ":")) continue;
    const owner = exprTypeBefore(tokens, tokens.indexOf(sep2), types);
    if (!owner) continue;

    const paramTypes = eventParamTypes(owner, evt.value);
    if (!paramTypes) continue;

    // `Connect ( function ( a , b )`
    const open = nextSignificantFrom(tokens, i + 1);
    if (!open || open.tok.value !== "(") continue;
    const fn = nextSignificantFrom(tokens, open.i + 1);
    if (!fn || fn.tok.value !== "function") continue;
    const argsOpen = nextSignificantFrom(tokens, fn.i + 1);
    if (!argsOpen || argsOpen.tok.value !== "(") continue;

    let k = argsOpen.i + 1;
    let slot = 0;
    for (;;) {
      const p = nextSignificantFrom(tokens, k);
      if (!p || p.tok.value === ")") break;
      if (p.tok.kind === "ident") {
        const type = paramTypes[slot];
        // Only bind names whose declared type is something that can own members.
        if (type && !types.has(p.tok.value)) types.set(p.tok.value, type);
        slot++;
      }
      const comma = nextSignificantFrom(tokens, p.i + 1);
      if (!comma || comma.tok.value !== ",") break;
      k = comma.i + 1;
    }
  }
}

/** The identifier immediately before the `.`/`:` at `sepIndex`, if any. */
function recvValue(tokens: Token[], sepIndex: number): string | undefined {
  for (let j = sepIndex - 1; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.kind === "whitespace" || t.kind === "comment") continue;
    return t.kind === "ident" || t.kind === "builtin" ? t.value : undefined;
  }
  return undefined;
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
export function isTypePosition(tokens: Token[], i: number, prev: Token): boolean {
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
