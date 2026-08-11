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

/**
 * Kinds that can spell an API name.
 *
 * `legacy` is here because it was carved out of `builtin`, and this predicate is
 * the reason it could be: the scanner below is keyed off token kind in a dozen
 * places, so a new kind that any one of them forgot would have silently stopped
 * every finding on `wait`, `spawn` and `tick` — the most common findings there
 * are — with nothing failing loudly. Ask this, never `kind === "ident"`.
 */
function isName(t: Token): boolean {
  return t.kind === "ident" || t.kind === "builtin" || t.kind === "legacy";
}

/**
 * Kinds that can spell a name the *author* chose: a local, a parameter, a method.
 *
 * Deliberately excludes `builtin`, which is how `local print = …` has always
 * been left alone here. `legacy` belongs: `loadstring` and `ypcall` were plain
 * idents before they got their own kind, and someone's own `function t:wait()`
 * is still their own.
 */
function isPlainName(t: Token): boolean {
  return t.kind === "ident" || t.kind === "legacy";
}

/** Index of the previous significant token, or -1. */
function prevSigIdx(tokens: Token[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    const k = tokens[j]!.kind;
    if (k !== "whitespace" && k !== "comment") return j;
  }
  return -1;
}

/** Index of the first significant token at or after `from`, or -1. */
function nextSigIdx(tokens: Token[], from: number): number {
  for (let j = from; j < tokens.length; j++) {
    const k = tokens[j]!.kind;
    if (k !== "whitespace" && k !== "comment") return j;
  }
  return -1;
}

/**
 * These return indices rather than tokens on purpose.
 *
 * The token-returning versions forced every caller that needed to keep walking
 * to find its way back with `tokens.indexOf(…)`, and there were eighteen of
 * those between here and the renderer: a 3,263-token block spent 7.44M
 * comparisons inside them, 70% of it in `isDefinitionSite` alone. Indices took a
 * 1,247-line block from 30.4ms to 6.7ms. Nothing below may reintroduce an
 * `indexOf` on this path.
 */

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

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "keyword" || t.value !== "local") continue;

    const nameIdx = nextSigIdx(tokens, i + 1);
    if (nameIdx < 0 || !isPlainName(tokens[nameIdx]!)) continue;
    const name = tokens[nameIdx]!;

    /* `local hum: Humanoid = …`. An annotation outranks anything inferred from
     * the right-hand side, because the author stated it outright. Told apart
     * from `local x = a:b()` by the colon sitting directly after the name. */
    const colonIdx = nextSigIdx(tokens, nameIdx + 1);
    if (colonIdx >= 0 && tokens[colonIdx]!.value === ":") {
      const annIdx = nextSigIdx(tokens, colonIdx + 1);
      if (annIdx >= 0 && isName(tokens[annIdx]!)) {
        types.set(name.value, tokens[annIdx]!.value);
        continue;
      }
    }

    const eqIdx = nextSigIdx(tokens, nameIdx + 1);
    if (eqIdx < 0 || tokens[eqIdx]!.value !== "=") continue;

    /* Walk the right-hand side for `<.|:> <fn> ( "<string>"`, rather than only
     * looking immediately after `=`. That is what lets a receiver reached
     * through a hop resolve — `otherpart.Parent:FindFirstChild("Humanoid")` —
     * where before only a call sitting flush against `=` was ever seen.
     *
     * Bounded by the next statement keyword so this never runs away down the
     * file, and by a token budget for pathological one-liners. */
    let j = eqIdx + 1;
    let budget = 24;
    while (budget-- > 0) {
      const stepIdx = nextSigIdx(tokens, j);
      if (stepIdx < 0) break;
      const step = tokens[stepIdx]!;
      if (step.kind === "keyword" && STOPS.has(step.value)) break;

      if (step.value !== "." && step.value !== ":") {
        j = stepIdx + 1;
        continue;
      }

      const fnIdx = nextSigIdx(tokens, stepIdx + 1);
      if (fnIdx < 0) break;
      const parenIdx = nextSigIdx(tokens, fnIdx + 1);
      const argIdx = parenIdx >= 0 && tokens[parenIdx]!.value === "(" ? nextSigIdx(tokens, parenIdx + 1) : -1;
      if (argIdx < 0 || tokens[argIdx]!.kind !== "string") {
        j = fnIdx + 1;
        continue;
      }

      const recvName = recvValue(tokens, stepIdx);
      const fnName = tokens[fnIdx]!.value;

      const isNew = recvName === "Instance" && fnName === "new";
      const isService = fnName === "GetService" && GLOBAL_TYPES[recvName ?? ""] === "DataModel";

      if (isNew || isService || CLASS_TYPED_CALLS.has(fnName)) {
        types.set(name.value, stringValue(tokens[argIdx]!));
        break;
      }

      j = fnIdx + 1;
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
      const nameIdx = nextSigIdx(tokens, i + 1);
      if (nameIdx < 0 || !isPlainName(tokens[nameIdx]!) || types.has(tokens[nameIdx]!.value)) continue;
      const eqIdx = nextSigIdx(tokens, nameIdx + 1);
      if (eqIdx < 0 || tokens[eqIdx]!.value !== "=") continue;
      const headIdx = nextSigIdx(tokens, eqIdx + 1);
      if (headIdx < 0) continue;

      const chain = chainType(tokens, headIdx, types);
      // Only when the chain actually stepped through a member — a bare
      // `local a = b` alias is not what this is for.
      if (chain && chain.end > headIdx) types.set(tokens[nameIdx]!.value, chain.type);
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
  if (!head || !isName(head)) return null;

  let current = types.get(head.value) ?? GLOBAL_TYPES[head.value];
  if (!current) return null;

  let end = i;
  let j = i + 1;
  for (;;) {
    const sepIdx = nextSigIdx(tokens, j);
    if (sepIdx < 0) break;
    const sep = tokens[sepIdx]!;
    if (sep.value !== "." && sep.value !== ":") break;
    const memberIdx = nextSigIdx(tokens, sepIdx + 1);
    if (memberIdx < 0 || !isName(tokens[memberIdx]!)) break;

    const next = memberType(current, tokens[memberIdx]!.value);
    if (!next) break;
    current = next;
    end = memberIdx;
    j = memberIdx + 1;
  }

  return { type: current, end };
}

/**
 * The index of the bracket matching the closer at `closeIdx`, or -1.
 *
 * String tokens are skipped so a `")"` inside a literal cannot unbalance the
 * count.
 */
function matchingOpen(tokens: Token[], closeIdx: number): number {
  const close = tokens[closeIdx]?.value;
  if (close !== ")" && close !== "]" && close !== "}") return -1;
  const open = close === ")" ? "(" : close === "]" ? "[" : "{";
  let depth = 0;
  for (let j = closeIdx; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.kind === "string" || t.kind === "comment") continue;
    if (t.value === close) depth++;
    else if (t.value === open) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
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
  const prevIdx = prevSigIdx(tokens, sepIdx);
  if (prevIdx < 0) return undefined;
  const prev = tokens[prevIdx]!;

  if (isName(prev)) {
    return types.get(prev.value) ?? GLOBAL_TYPES[prev.value];
  }

  // A call expression: walk back over the balanced parens to its callee.
  if (prev.value !== ")") return undefined;
  const openIdx = matchingOpen(tokens, prevIdx);
  if (openIdx < 0) return undefined;

  const argIdx = nextSigIdx(tokens, openIdx + 1);
  const fnIdx = prevSigIdx(tokens, openIdx);
  if (argIdx < 0 || fnIdx < 0 || tokens[argIdx]!.kind !== "string") return undefined;
  const fn = tokens[fnIdx]!;

  const sepBefore = prevSigIdx(tokens, fnIdx);
  const recvIdx = sepBefore >= 0 ? prevSigIdx(tokens, sepBefore) : -1;
  const recv = recvIdx >= 0 ? tokens[recvIdx]! : null;
  const recvType = recv ? (types.get(recv.value) ?? GLOBAL_TYPES[recv.value]) : undefined;

  const isService = fn.value === "GetService" && recvType === "DataModel";
  const isNew = fn.value === "new" && recv?.value === "Instance";
  if (isService || isNew || CLASS_TYPED_CALLS.has(fn.value)) return stringValue(tokens[argIdx]!);
  return undefined;
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
    const colonIdx = prevSigIdx(tokens, i);
    if (colonIdx < 0) continue;
    const colon = tokens[colonIdx]!;
    if (colon.value !== ":" && colon.value !== ".") continue;
    const evtIdx = prevSigIdx(tokens, colonIdx);
    if (evtIdx < 0 || !isName(tokens[evtIdx]!)) continue;
    const evt = tokens[evtIdx]!;

    // The receiver is whatever chain sits before the event name.
    const sep2 = prevSigIdx(tokens, evtIdx);
    if (sep2 < 0 || (tokens[sep2]!.value !== "." && tokens[sep2]!.value !== ":")) continue;
    const owner = exprTypeBefore(tokens, sep2, types);
    if (!owner) continue;

    const paramTypes = eventParamTypes(owner, evt.value);
    if (!paramTypes) continue;

    // `Connect ( function ( a , b )`
    const openIdx = nextSigIdx(tokens, i + 1);
    if (openIdx < 0 || tokens[openIdx]!.value !== "(") continue;
    const fnIdx = nextSigIdx(tokens, openIdx + 1);
    if (fnIdx < 0 || tokens[fnIdx]!.value !== "function") continue;
    const argsOpen = nextSigIdx(tokens, fnIdx + 1);
    if (argsOpen < 0 || tokens[argsOpen]!.value !== "(") continue;

    let k = argsOpen + 1;
    let slot = 0;
    for (;;) {
      const pIdx = nextSigIdx(tokens, k);
      if (pIdx < 0 || tokens[pIdx]!.value === ")") break;
      if (isPlainName(tokens[pIdx]!)) {
        const type = paramTypes[slot];
        // Only bind names whose declared type is something that can own members.
        if (type && !types.has(tokens[pIdx]!.value)) types.set(tokens[pIdx]!.value, type);
        slot++;
      }
      const commaIdx = nextSigIdx(tokens, pIdx + 1);
      if (commaIdx < 0 || tokens[commaIdx]!.value !== ",") break;
      k = commaIdx + 1;
    }
  }
}

/** The identifier immediately before the `.`/`:` at `sepIndex`, if any. */
function recvValue(tokens: Token[], sepIndex: number): string | undefined {
  const j = prevSigIdx(tokens, sepIndex);
  if (j < 0) return undefined;
  return isName(tokens[j]!) ? tokens[j]!.value : undefined;
}

/** Keywords that cannot appear inside a parameter list or a table type. */
const LIST_EDGE = new Set([
  "end", "then", "do", "return", "if", "elseif", "else", "while", "repeat",
  "until", "local", "for", "in",
]);

/**
 * The innermost bracket left open before `i`, or -1.
 *
 * Bounded: a runaway backward scan on a 3,000-token block is the cost this whole
 * file was just rewritten to avoid, and "no enclosing list" is the answer that
 * fails safe — it means an identifier stays a value.
 */
function enclosingOpener(tokens: Token[], i: number): number {
  let depth = 0;
  let budget = 200;
  for (let j = i - 1; j >= 0 && budget-- > 0; j--) {
    const t = tokens[j]!;
    if (t.kind === "whitespace" || t.kind === "comment" || t.kind === "string") continue;
    const v = t.value;
    if (v === ")" || v === "]" || v === "}") depth++;
    else if (v === "(" || v === "[" || v === "{") {
      if (depth === 0) return j;
      depth--;
    } else if (t.kind === "keyword" && LIST_EDGE.has(v)) return -1;
  }
  return -1;
}

/**
 * The `<` opening the generic list that contains `i`, or -1.
 *
 * `<` is also less-than, so this only steps over tokens that can appear inside a
 * type list and gives up the moment it sees anything else. `f(a, b)` bails at
 * the `(` after two steps, which is the point: a wrong answer here paints an
 * ordinary expression as a type.
 */
function openGenericBefore(tokens: Token[], i: number): number {
  let depth = 0;
  let seen = 0;
  for (let j = i - 1; j >= 0 && seen < 40; j--) {
    const t = tokens[j]!;
    if (t.kind === "whitespace" || t.kind === "comment") continue;
    seen++;
    const v = t.value;
    if (v === ">") {
      depth++;
      continue;
    }
    if (v === "<") {
      if (depth === 0) return j;
      depth--;
      continue;
    }
    if (isName(t)) continue;
    if (v === "," || v === "." || v === "?" || v === "|" || v === "&" || v === "{" || v === "}") continue;
    return -1;
  }
  return -1;
}

/** Does the `(` at `k` open a function's parameters rather than a call's arguments? */
function opensParamList(tokens: Token[], k: number): boolean {
  if (tokens[k]?.value !== "(") return false;
  const p = prevSigIdx(tokens, k);
  if (p < 0) return false;
  const t = tokens[p]!;
  // `function(x: T)` — anonymous.
  if (t.kind === "keyword" && t.value === "function") return true;
  // `function f(x: T)`, `function M:update(x: T)`.
  return isName(t) && isFunctionNameSite(tokens, p);
}

/** Does the `<` at `k` open a generic list — `type Map<K, V>`, `Array<string>`? */
function opensGeneric(tokens: Token[], k: number, depth: number): boolean {
  const nameIdx = prevSigIdx(tokens, k);
  if (nameIdx < 0 || !isName(tokens[nameIdx]!)) return false;
  const declIdx = prevSigIdx(tokens, nameIdx);
  if (declIdx >= 0) {
    const decl = tokens[declIdx]!;
    if (decl.kind === "keyword" && decl.value === "type") return true;
  }
  return isTypePositionAt(tokens, nameIdx, declIdx, depth + 1);
}

/**
 * Is the token at `k` the start of the right-hand side of `type X = …`?
 *
 * Everything right of that `=` is a type, however it is spelled — a table, a
 * function type, a union, a bare name.
 */
function afterTypeAlias(tokens: Token[], k: number): boolean {
  const eq = prevSigIdx(tokens, k);
  if (eq < 0 || tokens[eq]!.value !== "=" || tokens[eq]!.kind !== "operator") return false;
  let n = prevSigIdx(tokens, eq);
  // `type Map<K, V> = …` — step back over the generic list to reach the name.
  if (n >= 0 && tokens[n]!.value === ">") {
    const open = openGenericBefore(tokens, n);
    n = open >= 0 ? prevSigIdx(tokens, open) : -1;
  }
  if (n < 0 || !isName(tokens[n]!)) return false;
  const kw = prevSigIdx(tokens, n);
  return kw >= 0 && tokens[kw]!.kind === "keyword" && tokens[kw]!.value === "type";
}

/**
 * Does the `{` at `k` open a table *type* rather than a table constructor?
 *
 * `{ x: number }` and `{ f(), obj:Method() }` are told apart by what stands in
 * front of the brace, never by what is inside it.
 */
function opensTypeTable(tokens: Token[], k: number, depth: number): boolean {
  if (tokens[k]?.value !== "{") return false;
  return isTypePositionAt(tokens, k, prevSigIdx(tokens, k), depth + 1);
}

/**
 * Is the `:` at `colonIdx` an annotation rather than a method call?
 *
 * This is the one genuinely ambiguous character in Luau's surface syntax, and
 * getting it wrong is expensive in both directions: `obj:GetName()` read as an
 * annotation loses the method colour and the docs link, and `x: number` read as
 * a call paints the type in the gold reserved for `:Connect`.
 *
 * The answer is never the colon itself, always the *declarator* — the token in
 * front of whatever the colon is attached to. `local x`, a parameter list's `(`
 * or `,`, and a table type's `{` or `;` all declare; the same `(` and `,` inside
 * a *call* do not, which is why each one is checked against what actually opened
 * the list rather than accepted on sight.
 */
export function isAnnotationColon(tokens: Token[], colonIdx: number, depth = 0): boolean {
  if (tokens[colonIdx]?.value !== ":") return false;
  if (depth > 4) return false;
  const p = prevSigIdx(tokens, colonIdx);
  if (p < 0) return false;
  const prev = tokens[p]!;

  /* `function f(a: number): boolean` — a return type, where there is no name in
   * front of the colon at all. The `)` has to be the one closing a parameter
   * list: `game:GetService("X"):FindFirstChild(…)` puts a `)` here too, and that
   * is a method call on a call result. */
  if (prev.value === ")") {
    const open = matchingOpen(tokens, p);
    return open >= 0 && opensParamList(tokens, open);
  }

  if (!isName(prev)) return false;
  const d = prevSigIdx(tokens, p);
  if (d < 0) return false;
  const decl = tokens[d]!;

  if (decl.kind === "keyword" && decl.value === "local") return true;
  if (decl.value === "(") return opensTypeParens(tokens, d, depth);
  if (decl.value === "{") return opensTypeTable(tokens, d, depth);
  if (decl.value === "," || decl.value === ";") {
    const open = enclosingOpener(tokens, d);
    if (open < 0) return false;
    const o = tokens[open]!.value;
    if (o === "(") return opensTypeParens(tokens, open, depth);
    if (o === "{") return opensTypeTable(tokens, open, depth);
  }
  return false;
}

/**
 * A `(` whose contents can carry annotations: a real parameter list, or the
 * parameter list of a function *type* — `type Handler = (msg: string) -> ()`.
 */
function opensTypeParens(tokens: Token[], k: number, depth: number): boolean {
  return (
    opensParamList(tokens, k) ||
    isTypePositionAt(tokens, k, prevSigIdx(tokens, k), depth + 1)
  );
}

/**
 * Is the identifier at `i` naming a type rather than a value?
 *
 * Every annotation in one signature has to agree, because the failure was not
 * "one token is the wrong colour". On
 *
 *     local function f(a: number, b: string): boolean
 *
 * `number` came out unstyled, `string` in builtin blue and `boolean` in the gold
 * reserved for `:Connect` — three annotations reading as three different kinds
 * of thing — and `type Point = { x: number, y: number }` gave two identical
 * fields two different colours, because the comma arm happened to rescue every
 * field but the first.
 */
export function isTypePosition(tokens: Token[], i: number, prevIdx: number): boolean {
  return isTypePositionAt(tokens, i, prevIdx, 0);
}

function isTypePositionAt(tokens: Token[], i: number, prevIdx: number, depth: number): boolean {
  if (prevIdx < 0 || depth > 4) return false;
  const prev = tokens[prevIdx]!;

  // `x :: T` and `(…) -> T` — unambiguous.
  if (prev.kind === "operator" && (prev.value === "::" || prev.value === "->")) return true;

  // `type Point = …` — the name being declared. The tokenizer only calls `type`
  // a keyword where it declares, so `type(v)` never reaches this.
  if (prev.kind === "keyword" && prev.value === "type") return true;

  // `T | U`, `T & U` — an arm is a type when the arm before it is one. (Neither
  // character is a binary operator in Luau expressions, so nothing else reaches
  // here.)
  if (prev.kind === "operator" && (prev.value === "|" || prev.value === "&")) {
    const arm = prevSigIdx(tokens, prevIdx);
    if (arm < 0 || !isName(tokens[arm]!)) return false;
    return isTypePositionAt(tokens, arm, prevSigIdx(tokens, arm), depth + 1);
  }

  // `Array<string>`, `type Map<K, V>` — inside a generic argument list.
  if (prev.value === "<" || prev.value === ",") {
    const open = prev.value === "<" ? prevIdx : openGenericBefore(tokens, i);
    if (open >= 0 && opensGeneric(tokens, open, depth)) return true;
  }

  // `type Handler = (msg: string) -> ()` — the whole right-hand side is a type.
  if (prev.value === "=" && afterTypeAlias(tokens, i)) return true;

  return prev.value === ":" && isAnnotationColon(tokens, prevIdx, depth);
}

/**
 * Is the member at `i` being *defined* rather than called?
 *
 * `function ragdoll:destroy()` is somebody writing their own method that happens
 * to share a name with a legacy alias. Marking it deprecated tells them their
 * own API is wrong. Walks back through any dotted path — `function a.b.c:m()` —
 * to see whether the chain starts at `function`.
 */
export function isDefinitionSite(tokens: Token[], i: number): boolean {
  let cursor = i;
  // Alternate <ident> <. or :> going left, up to a few segments.
  for (let hops = 0; cursor >= 0 && hops < 8; hops++) {
    const sep = prevSigIdx(tokens, cursor);
    if (sep < 0) return false;
    const sv = tokens[sep]!.value;
    if (sv !== "." && sv !== ":") return false;
    const owner = prevSigIdx(tokens, sep);
    if (owner < 0) return false;
    const beforeIdx = prevSigIdx(tokens, owner);
    if (beforeIdx < 0) return false;
    const before = tokens[beforeIdx]!;
    if (before.kind === "keyword" && before.value === "function") return true;
    if (before.value !== "." && before.value !== ":") return false;
    cursor = owner;
  }
  return false;
}

/**
 * Is the token at `i` the *name* in a function declaration, in any of its forms?
 *
 * `local function step()`, `function foo()`, `function M.init()` and
 * `function M:update()` produced no class, no class, a field colour and a method
 * colour — four spellings of one thing, wearing three different colours, and a
 * definition byte-identical to every one of its call sites.
 *
 * It also decides where a docs link must *not* go. On `local Sound = {}` /
 * `function Sound:Play()`, the member resolver produced `Sound.Play`, which the
 * isolated world confirms against the real member index and turns into a live
 * link to the engine's `Sound.Play` — someone else's method, on someone else's
 * class. 53 of the 647 documented class names are ordinary module names.
 */
export function isFunctionNameSite(tokens: Token[], i: number): boolean {
  const t = tokens[i];
  if (!t || !isName(t)) return false;
  /* The declared name is the last hop of the chain: in `function M.init()` the
   * `M` is an ordinary table reference and keeps the colour it wears at every
   * other mention of it. Luau always parenthesises a declaration, so the `(` —
   * or a generic list — is what ends the chain. */
  const nxt = nextSigIdx(tokens, i + 1);
  if (nxt < 0) return false;
  const nv = tokens[nxt]!.value;
  if (nv !== "(" && nv !== "<") return false;
  const p = prevSigIdx(tokens, i);
  if (p >= 0 && tokens[p]!.kind === "keyword" && tokens[p]!.value === "function") return true;
  return isDefinitionSite(tokens, i);
}

/**
 * Every name the snippet introduces for itself: locals, parameters, loop
 * variables and the names of the functions it declares.
 *
 * A name is not a class just because it is spelled like one. `local Sound = {}`,
 * `local Model = …`, `for _, Tool in pairs(…)` — Player, Sound, Camera, Model,
 * Tool and Frame are all real Roblox classes *and* the names people give their
 * own modules, and linking those to create.roblox.com is the "lying affordance"
 * the renderer's own contract forbids. Where the class was actually inferred the
 * caller uses the inference; this set is only ever a veto on spelling.
 */
export function declaredNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "keyword") continue;

    if (t.value === "local" || t.value === "for") {
      let j = nextSigIdx(tokens, i + 1);
      // `local function f()` declares `f` too; the parameters are picked up by
      // the `function` arm below on the next iteration.
      if (j >= 0 && tokens[j]!.kind === "keyword" && tokens[j]!.value === "function") {
        j = nextSigIdx(tokens, j + 1);
      }
      // `local a, b, c` / `for k, v in …`. Stops at `:`, `=`, `in` or anything
      // else, so an annotation's type name is never collected as a declaration.
      for (; j >= 0; ) {
        if (!isName(tokens[j]!)) break;
        names.add(tokens[j]!.value);
        const c = nextSigIdx(tokens, j + 1);
        if (c < 0 || tokens[c]!.value !== ",") break;
        j = nextSigIdx(tokens, c + 1);
      }
      continue;
    }

    // `type Tool = { … }` — a name the author defined, whatever the engine also
    // calls one of its classes.
    if (t.value === "type") {
      const n = nextSigIdx(tokens, i + 1);
      if (n >= 0 && isName(tokens[n]!)) names.add(tokens[n]!.value);
      continue;
    }

    if (t.value !== "function") continue;

    // Skip the name chain — `M.init`, `M:update` — to the parameter list.
    let j = nextSigIdx(tokens, i + 1);
    while (j >= 0 && tokens[j]!.value !== "(") {
      const v = tokens[j]!.value;
      if (!isName(tokens[j]!) && v !== "." && v !== ":") break;
      if (isName(tokens[j]!)) names.add(tokens[j]!.value);
      j = nextSigIdx(tokens, j + 1);
    }
    if (j < 0 || tokens[j]!.value !== "(") continue;

    /* Parameters only, never their annotations: `function f(part: Part)` must
     * not add `Part`. A name counts when it opens the list or follows a comma at
     * depth zero; everything after it belongs to its type. */
    let expect = true;
    let depth = 0;
    for (let k = nextSigIdx(tokens, j + 1); k >= 0; k = nextSigIdx(tokens, k + 1)) {
      const v = tokens[k]!.value;
      if (v === "(" || v === "{" || v === "[") depth++;
      else if (v === ")" || v === "}" || v === "]") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && v === ",") {
        expect = true;
        continue;
      } else if (depth === 0 && expect && isName(tokens[k]!)) {
        names.add(tokens[k]!.value);
      }
      expect = false;
    }
  }

  return names;
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
    if (!isPlainName(t)) continue;
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

    // Only names can name an API. Comments and strings are skipped implicitly by
    // never being considered here — except for the Instance.new("ClassName")
    // case handled below, which reads the string deliberately.
    if (!isName(t)) continue;

    const prevIdx = prevSigIdx(tokens, i);
    const prev = prevIdx >= 0 ? tokens[prevIdx]! : null;
    const nextIdx = nextSigIdx(tokens, i + 1);
    const next = nextIdx >= 0 ? tokens[nextIdx]! : null;
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
    if (asType && isTypePosition(tokens, i, prevIdx)) {
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
      const isMethod = prev!.value === ":";
      const receiverIdx = prevSigIdx(tokens, prevIdx);
      const receiver = receiverIdx >= 0 ? tokens[receiverIdx]! : null;
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
      if (next?.value !== ".") continue;
      const nwIdx = nextSigIdx(tokens, nextIdx + 1);
      if (nwIdx < 0 || tokens[nwIdx]!.value !== "new") continue;
      const parenIdx = nextSigIdx(tokens, nwIdx + 1);
      if (parenIdx < 0 || tokens[parenIdx]!.value !== "(") continue;
      const argIdx = nextSigIdx(tokens, parenIdx + 1);
      if (argIdx < 0 || tokens[argIdx]!.kind !== "string") continue;
      const arg = tokens[argIdx]!;

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
      const afterArgIdx = nextSigIdx(tokens, argIdx + 1);
      if (afterArgIdx >= 0 && tokens[afterArgIdx]!.value === ",") {
        // Span the whole `, parent` argument, not just the comma. A wavy
        // underline four pixels wide is not a finding anyone will notice, and
        // the argument is what has to be deleted.
        let depth = 0;
        let end = tokens[afterArgIdx]!.end;
        for (let j = afterArgIdx; j < tokens.length; j++) {
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
          start: tokens[afterArgIdx]!.start,
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
