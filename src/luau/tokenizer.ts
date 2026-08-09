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
  | "ident"
  | "number"
  | "string"
  | "comment"
  | "operator"
  | "punct"
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
  // Luau additions. `continue`, `type` and `export` are contextual keywords —
  // still valid identifiers — but colouring them as keywords matches intent.
  "continue", "export", "type",
]);

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
  "Random", "DateTime", "Rect", "Font", "PhysicalProperties", "os", "delay",
  "spawn", "wait", "tick", "time", "elapsedTime",
]);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/**
 * `[[ … ]]`, `[==[ … ]==]`. Returns the index after the closing bracket, or -1
 * if this is not a long bracket at all.
 */
function readLongBracket(src: string, i: number): number {
  if (src[i] !== "[") return -1;
  let j = i + 1;
  let level = 0;
  while (src[j] === "=") {
    level++;
    j++;
  }
  if (src[j] !== "[") return -1;
  const close = `]${"=".repeat(level)}]`;
  const end = src.indexOf(close, j + 1);
  return end === -1 ? src.length : end + close.length;
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) =>
    tokens.push({ kind, value: src.slice(start, end), start, end });

  while (i < src.length) {
    const c = src[i]!;

    // Whitespace
    if (/\s/.test(c)) {
      const start = i;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      push("whitespace", start, i);
      continue;
    }

    // Comments — long form first, so `--[[ … ]]` is not read as `--` to EOL.
    if (c === "-" && src[i + 1] === "-") {
      const start = i;
      const long = readLongBracket(src, i + 2);
      if (long !== -1) {
        i = long;
      } else {
        while (i < src.length && src[i] !== "\n") i++;
      }
      push("comment", start, i);
      continue;
    }

    // Long strings
    if (c === "[") {
      const long = readLongBracket(src, i);
      if (long !== -1) {
        const start = i;
        i = long;
        push("string", start, i);
        continue;
      }
    }

    // Quoted strings
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === "\n") break; // unterminated; stop at the line
        i++;
      }
      push("string", start, i);
      continue;
    }

    // Luau interpolated strings: `hello {name}`. Backticks are not Lua at all,
    // which is one of the things the Lua grammar gets visibly wrong.
    if (c === "`") {
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") { i++; break; }
        i++;
      }
      push("string", start, i);
      continue;
    }

    // Numbers, including 0x hex and Luau's 0b binary and _ separators.
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        i += 2;
        while (i < src.length && (isHex(src[i]!) || src[i] === "_")) i++;
      } else if (c === "0" && (src[i + 1] === "b" || src[i + 1] === "B")) {
        i += 2;
        while (i < src.length && (src[i] === "0" || src[i] === "1" || src[i] === "_")) i++;
      } else {
        while (i < src.length && (isDigit(src[i]!) || src[i] === "." || src[i] === "_")) i++;
        if (src[i] === "e" || src[i] === "E") {
          i++;
          if (src[i] === "+" || src[i] === "-") i++;
          while (i < src.length && isDigit(src[i]!)) i++;
        }
      }
      push("number", start, i);
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i]!)) i++;
      const word = src.slice(start, i);
      if (KEYWORDS.has(word)) push("keyword", start, i);
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

  return tokens;
}

/** Tokens that carry meaning — the stream a detector should walk. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "whitespace" && t.kind !== "comment");
}
