/**
 * A Luau tokenizer.
 *
 * Two jobs, and the second is the one that matters:
 *
 *  1. Highlighting. The forum's `highlighted_languages` setting lists `lua` and
 *     has no `luau` entry — verified from site settings — so every Luau snippet
 *     is tokenised by highlight.js's *Lua* grammar. Type annotations, `::`
 *     casts, `continue`, generics, string interpolation and compound assignment
 *     all come out wrong. This handles them.
 *
 *  2. Deprecation detection. Finding `wait(` with a regex also finds it inside
 *     `-- don't use wait()`, inside `"wait"`, and inside `myTable.wait`. A
 *     tokenizer knows which is which, and that is the difference between a
 *     feature people trust and one they turn off.
 *
 * Hand-written rather than Shiki: the detector needs a token stream anyway, and
 * a correct Luau tokenizer is a few hundred lines against Shiki's ~100 kB plus
 * a grammar. Doing both from one pass is smaller *and* more accurate here.
 */

export type TokenKind =
  | "keyword"
  | "builtin"
  /** A deprecated global. Its own kind because it must not wear stdlib blue. */
  | "legacy"
  | "ident"
  | "number"
  | "string"
  | "comment"
  | "operator"
  | "punct"
  /**
   * Not produced here, and cannot be: `Humanoid` in `local h: Humanoid` is
   * spelled exactly like `Humanoid` in `Humanoid.new()`, so type-ness is a
   * position, not a lexeme. `isTypePosition` in detect.ts decides it and
   * code-intel.ts paints it. Kept in the union so the kind vocabulary and the
   * `--dfp-code-*` role vocabulary stay one list.
   */
  | "type"
  | "whitespace";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
  "until", "while",
  // Luau additions. See CONTEXTUAL_KEYWORDS — these three are reserved only in
  // the positions where they declare something.
  "continue", "export", "type",
]);

/**
 * Keywords that are still ordinary names everywhere else, and are used that way.
 *
 * `type(v)` is the stdlib function; colouring it keyword-purple two tokens away
 * from `typeof(v)` in builtin-blue said the two were different kinds of thing.
 * `config.type` was worse: purple in the one position where a reserved word
 * cannot appear, and because `keyword` is not a member kind it did not even get
 * the field colour that `config.name` gets.
 */
const CONTEXTUAL_KEYWORDS = new Set(["continue", "export", "type"]);

const BUILTINS = new Set([
  "assert", "error", "getmetatable", "ipairs", "next", "pairs", "pcall",
  "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select",
  "setmetatable", "tonumber", "tostring", "type", "typeof", "unpack", "xpcall",
  "warn", "task", "math", "string", "table", "os", "coroutine", "bit32", "utf8",
  "debug", "buffer", "vector",
  // Roblox globals
  "game", "workspace", "script", "shared", "Instance", "Enum", "Vector3",
  "Vector2", "CFrame", "Color3", "UDim2", "UDim", "BrickColor", "Ray",
  "Region3", "TweenInfo", "NumberRange", "NumberSequence", "ColorSequence",
  "Random", "DateTime", "Rect", "Font", "PhysicalProperties",
]);

/**
 * Deprecated globals, checked before BUILTINS.
 *
 * These used to sit in BUILTINS, so `wait` and `task` rendered in the same
 * accent blue: the colour said "blessed stdlib" while a wavy underline said the
 * opposite, and `tick`/`time`/`elapsedTime` got the blue with no underline at
 * all. Dropping them from BUILTINS is not enough on its own — they fall to
 * `ident` and paint as plain text, which is exactly what `loadstring` and
 * `ypcall` already did wrong. They need a colour of their own, dimmed, and
 * nothing downstream ever promotes it.
 *
 * Only as a *bare* word. `task.wait` is the replacement for `wait`, not a use
 * of it, so member position (below) never reaches this set.
 */
const LEGACY_GLOBALS = new Set([
  "wait", "spawn", "delay", "tick", "time", "elapsedTime",
  "ypcall", "loadstring", "printidentity",
]);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/**
 * `[[ … ]]`, `[==[ … ]==]`.
 *
 * `null` when this is not a long bracket at all; otherwise the index after the
 * close *and whether it actually closed*. Those are two different answers, and
 * the old single-number signature could not tell them apart: it reported failure
 * as a successful read to end-of-source, so one unterminated `--[[` in a paste
 * rendered every following line grey italic — as if the snippet were commented
 * out — and every downstream check silently stopped. Callers decide what to do,
 * because the right answer differs: an unclosed comment really does run to the
 * end, an unclosed string almost certainly was not a string.
 */
function readLongBracket(
  src: string,
  i: number,
  to: number,
): { end: number; closed: boolean } | null {
  if (src[i] !== "[") return null;
  let j = i + 1;
  let level = 0;
  while (j < to && src[j] === "=") {
    level++;
    j++;
  }
  if (src[j] !== "[") return null;
  const close = `]${"=".repeat(level)}]`;
  const end = src.indexOf(close, j + 1);
  if (end === -1 || end + close.length > to) return { end: to, closed: false };
  return { end: end + close.length, closed: true };
}

/** Index just past a `"…"`, `'…'` or `` `…` `` run, or at the newline that ends it. */
function skipQuoted(src: string, i: number, to: number): number {
  const quote = src[i]!;
  let j = i + 1;
  while (j < to) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === "\n") return j;
    if (src[j] === quote) return j + 1;
    j++;
  }
  return to;
}

/** The last token that carries meaning, for the one lookbehind this needs. */
function lastSignificant(tokens: Token[]): Token | null {
  for (let j = tokens.length - 1; j >= 0; j--) {
    const t = tokens[j]!;
    if (t.kind !== "whitespace" && t.kind !== "comment") return t;
  }
  return null;
}

/**
 * `type Point = …` and `type Map<K, V> = …` declare; `type(v)` calls.
 *
 * `from` is the index just past the word. Whitespace only — `type --[[?]] X` is
 * not a shape anyone writes, and skipping comments here would cost a second
 * scanner for nothing.
 */
function declaresType(src: string, from: number, to: number): boolean {
  let j = from;
  while (j < to && /\s/.test(src[j]!)) j++;
  if (j >= to || !isIdentStart(src[j]!)) return false;
  while (j < to && isIdentPart(src[j]!)) j++;
  while (j < to && /\s/.test(src[j]!)) j++;
  // `<` is the generic parameter list; `==` is a comparison, not a declaration.
  if (src[j] === "<") return true;
  return src[j] === "=" && src[j + 1] !== "=";
}

/** Is a keyword actually reserved *here*, or is it one of the contextual three? */
function keywordHere(word: string, isMember: boolean, src: string, from: number, to: number): boolean {
  if (!CONTEXTUAL_KEYWORDS.has(word)) return true;
  if (isMember) return false;
  // `type` is the only one that is also a stdlib function. Keep the keyword
  // colour where it declares and let `type(v)` fall through to the builtin.
  if (word !== "type") return true;
  return declaresType(src, from, to);
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  scan(src, 0, src.length, tokens);
  return tokens;
}

/**
 * Tokenize `src[from … to)` into `tokens`, with offsets absolute into `src`.
 *
 * The range exists so an interpolated string can hand its `{ … }` expressions
 * back to the same code, at their real positions, and have them land in the same
 * flat stream — see the backtick branch.
 */
function scan(src: string, from: number, to: number, tokens: Token[]): void {
  let i = from;
  const push = (kind: TokenKind, start: number, end: number) =>
    tokens.push({ kind, value: src.slice(start, end), start, end });

  while (i < to) {
    const c = src[i]!;

    // Whitespace
    if (/\s/.test(c)) {
      const start = i;
      while (i < to && /\s/.test(src[i]!)) i++;
      push("whitespace", start, i);
      continue;
    }

    // Comments — long form first, so `--[[ … ]]` is not read as `--` to EOL.
    if (c === "-" && src[i + 1] === "-") {
      const start = i;
      const long = readLongBracket(src, i + 2, to);
      // An unterminated `--[[` really does comment out everything after it, so
      // swallowing to the end is what the parser would do. Only the *string*
      // case below is worth recovering from.
      if (long) {
        i = long.end;
      } else {
        while (i < to && src[i] !== "\n") i++;
      }
      push("comment", start, i);
      continue;
    }

    // Long strings
    if (c === "[") {
      const long = readLongBracket(src, i, to);
      if (long?.closed) {
        const start = i;
        i = long.end;
        push("string", start, i);
        continue;
      }
      /* Unterminated: fall through deliberately. `[` opens an index expression
       * far more often than it opens a forty-line string, so emitting it as
       * punct and carrying on keeps the rest of the block's colours, marks and
       * links — where treating it as a string to end-of-source lost all three. */
    }

    // Quoted strings
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      while (i < to) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === "\n") break; // unterminated; stop at the line
        i++;
      }
      push("string", start, i);
      continue;
    }

    /* Luau interpolated strings: `hi {player.Name}`. Backticks are not Lua at
     * all, which is one of the things the Lua grammar gets visibly wrong.
     *
     * Emitted as a flat run — literal, `{`, the expression's own tokens, `}` —
     * rather than one opaque token, for two reasons. `hum.Health` inside a
     * template lost the `Humanoid.Health` resolution it gets three characters
     * outside one, and interpolation is a third of the stated reason this file
     * exists. And the newline bail is the one the quoted-string loop above has
     * always had: without it a single stray backtick collapsed every following
     * line into one string span, taking every mark and link on them with it. */
    if (c === "`") {
      const start = i;
      let run = i; // start of the current literal run, opening backtick included
      i++;
      while (i < to) {
        const d = src[i]!;
        if (d === "\\") { i += 2; continue; }
        if (d === "\n") break; // unterminated; stop at the line
        if (d === "`") { i++; break; }
        if (d !== "{") { i++; continue; }

        if (i > run) push("string", run, i);
        push("punct", i, i + 1);
        i++;

        /* The expression ends at the brace matching this one. Table
         * constructors nest braces and nested templates hide them inside
         * strings, so count depth and skip anything quoted. */
        const expr = i;
        let depth = 0;
        while (i < to) {
          const e = src[i]!;
          if (e === "\n") break;
          if (e === '"' || e === "'" || e === "`") { i = skipQuoted(src, i, to); continue; }
          if (e === "{") { depth++; i++; continue; }
          if (e === "}") {
            if (depth === 0) break;
            depth--;
            i++;
            continue;
          }
          i++;
        }
        scan(src, expr, i, tokens);
        if (src[i] === "}") {
          push("punct", i, i + 1);
          i++;
        }
        run = i;
      }
      if (i > run) push("string", run, i);
      continue;
    }

    // Numbers, including 0x hex and Luau's 0b binary and _ separators.
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        i += 2;
        while (i < to && (isHex(src[i]!) || src[i] === "_")) i++;
      } else if (c === "0" && (src[i + 1] === "b" || src[i + 1] === "B")) {
        i += 2;
        while (i < to && (src[i] === "0" || src[i] === "1" || src[i] === "_")) i++;
      } else {
        while (i < to && (isDigit(src[i]!) || src[i] === "." || src[i] === "_")) i++;
        if (i < to && (src[i] === "e" || src[i] === "E")) {
          i++;
          if (i < to && (src[i] === "+" || src[i] === "-")) i++;
          while (i < to && isDigit(src[i]!)) i++;
        }
      }
      push("number", start, i);
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(c)) {
      const start = i;
      while (i < to && isIdentPart(src[i]!)) i++;
      const word = src.slice(start, i);

      /* After a `.` or `:` the word is a field name, and field names live in
       * their own namespace: `config.type` is nobody's reserved word, and
       * `task.wait` is the *replacement* for `wait` rather than a use of it —
       * dimming it as legacy would have told people the correct answer was the
       * deprecated one. BUILTINS still applies here: the member colour comes
       * from position downstream, and `Enum.Font` has resolved through the
       * builtin kind since before this branch existed. */
      const prev = lastSignificant(tokens);
      const isMember =
        prev !== null && prev.kind === "punct" && (prev.value === "." || prev.value === ":");

      if (KEYWORDS.has(word) && keywordHere(word, isMember, src, i, to)) push("keyword", start, i);
      else if (LEGACY_GLOBALS.has(word) && !isMember) push("legacy", start, i);
      else if (BUILTINS.has(word)) push("builtin", start, i);
      else push("ident", start, i);
      continue;
    }

    // Operators. Longest match first so `::`, `...`, `//=` are not split —
    // `::` in particular is a Luau type cast the Lua grammar has no concept of.
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === "..." || three === "//=" || three === "..=") {
      push("operator", i, i + 3);
      i += 3;
      continue;
    }
    if (
      ["==", "~=", "<=", ">=", "..", "::", "->", "+=", "-=", "*=", "/=", "%=",
       "^=", "//"].includes(two)
    ) {
      push("operator", i, i + 2);
      i += 2;
      continue;
    }
    if ("+-*/%^#<>=~&|".includes(c)) {
      push("operator", i, i + 1);
      i++;
      continue;
    }

    push("punct", i, i + 1);
    i++;
  }
}

/** Tokens that carry meaning — the stream a detector should walk. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "whitespace" && t.kind !== "comment");
}
