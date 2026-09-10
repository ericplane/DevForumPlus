import { dropTitle, whyParts } from "../../src/isolated/docs-card";

/**
 * The deprecation card's reason text, and which native tooltips it replaces.
 *
 * `data-dfp-why` is written by code-intel from the rules file and may carry
 * backtick spans — "`wait()` throttles at 30 Hz" — which the card sets as
 * <code>. The split is the one place that text is interpreted at all, so the
 * cases here are the ones that would otherwise end up as innerHTML in a lesser
 * design: markup-looking prose, a stray backtick, an empty pair. Every part
 * has to come back as a plain string with its `code` bit and nothing else.
 *
 * `dropTitle` is the other decision: a mark or chip arrives with the same
 * message as a native `title`, and the browser's tooltip opened on top of the
 * card a second after it. The attribute goes only where the card will speak
 * instead — a mark with nothing to say keeps its tooltip, and a docs link's
 * `title` is code-intel's to drop, not this module's.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

/** Code parts in brackets, prose bare, `|` between parts. */
const parts = (why: string) =>
  whyParts(why)
    .map((p) => (p.code ? `[${p.text}]` : p.text))
    .join("|");

console.log("── backtick spans ─────────────────────────────────────────────────");
eq(parts("Throttled to 30 Hz; `task.wait()` is not."), "Throttled to 30 Hz; |[task.wait()]| is not.",
  "one span mid-sentence");
eq(parts("`a` and `b`"), "[a]| and |[b]", "leading and trailing spans, no empty parts");
eq(parts("`Instance.new(\"Part\", parent)`"), "[Instance.new(\"Part\", parent)]",
  "a span can hold quotes and parens");
eq(parts("plain prose"), "plain prose", "no backticks: one prose part");
eq(parts(""), "", "empty string: no parts");

console.log("\n── things that are not spans ──────────────────────────────────────");
eq(parts("a lone ` backtick"), "a lone ` backtick", "an unmatched backtick stays literal");
eq(parts("an empty `` pair"), "an empty `` pair", "an empty pair is not code");
eq(parts("`x` then a stray `"), "[x]| then a stray `", "a stray after a real span stays literal");
eq(parts("<b>bold</b> and `<i>y</i>`"), "<b>bold</b> and |[<i>y</i>]",
  "angle brackets are text on both sides of the backtick");

console.log("\n── shape ──────────────────────────────────────────────────────────");
const shaped = whyParts("see `x`");
check(shaped.length === 2, "two parts");
check(shaped.every((p) => typeof p.text === "string" && typeof p.code === "boolean"),
  "every part is {code, text}");
check(shaped[0]?.code === false && shaped[1]?.code === true, "prose first, code second");

console.log("\n── the native tooltip ─────────────────────────────────────────────");
/** An element with one class and its attributes: all `dropTitle` reads. */
class E {
  constructor(
    private cls: string,
    private attrs: Record<string, string>,
  ) {}
  matches(sel: string): boolean {
    return sel.split(",").some((s) => s.trim() === `.${this.cls}`);
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  get title(): string | null {
    return this.getAttribute("title");
  }
}
const drop = (cls: string, attrs: Record<string, string>) => {
  const e = new E(cls, { title: "Deprecated. …", ...attrs });
  dropTitle(e as unknown as HTMLElement);
  return e.title;
};

eq(drop("dfp-dep", { "data-dfp-replacement": "task.wait", "data-dfp-why": "" }), null,
  "a mark with a replacement loses its title");
eq(drop("dfp-dep", { "data-dfp-replacement": "", "data-dfp-why": "Throttled to 30 Hz." }), null,
  "a mark with only a reason loses it too");
eq(drop("dfp-code-finding", { "data-dfp-replacement": "task.wait", "data-dfp-why": "" }), null,
  "a findings chip is treated like its mark");
eq(drop("dfp-dep", { "data-dfp-replacement": "", "data-dfp-why": "" }), "Deprecated. …",
  "a mark with nothing to say keeps the tooltip it had");
eq(drop("dfp-dep", { "data-dfp-replacement": " ", "data-dfp-why": "\n" }), "Deprecated. …",
  "whitespace is nothing to say");
eq(drop("dfp-dep", {}), "Deprecated. …", "no attributes at all: nothing to say");
eq(drop("dfp-doc-link", { "data-dfp-replacement": "x", "data-dfp-why": "y" }), "Deprecated. …",
  "a docs link is not this module's title to drop");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
