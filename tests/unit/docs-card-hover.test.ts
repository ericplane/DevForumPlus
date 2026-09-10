import { targetLeft } from "../../src/isolated/docs-card";

/**
 * Which `mouseout`/`focusout` events count as leaving a hover target.
 *
 * A multi-token deprecation mark holds child spans — `<span>,</span> Players
 * <span>.</span>` inside one `.dfp-dep` — and a pointer crossing it fires a
 * mouseout at every child edge. Treating each as a leave cleared the dwell
 * timer, and the card never opened until the pointer went out and came back.
 * `targetLeft` is the decision that was wrong: it takes the event's target and
 * relatedTarget and answers with the target left, or null for a move that
 * stayed inside one. The tree here is the smallest thing with a `closest`,
 * which is all the function reads.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${got === null ? "null" : String(got)}`);

/** A node that is, or is not, a hover target; `closest` walks up for one. */
class N {
  constructor(
    public name: string,
    public hover: boolean,
    public parent: N | null = null,
  ) {}
  closest(_sel: string): N | null {
    for (let n: N | null = this; n; n = n.parent) if (n.hover) return n;
    return null;
  }
  toString(): string {
    return this.name;
  }
}

const left = (from: N | null, to: N | null) => targetLeft(from as unknown as EventTarget, to as unknown as EventTarget);

/* <pre><code> … <span.dfp-dep><span>,</span> Players<span>.</span></span> … */
const code = new N("code", false);
const mark = new N("mark", true, code);
const comma = new N("comma", false, mark);
const dot = new N("dot", false, mark);
const other = new N("other-mark", true, code);
const otherChild = new N("other-child", false, other);
const link = new N("link", true, code);

console.log("── moves inside one mark ──────────────────────────────────────────");
eq(left(comma, dot), null, "child to sibling child");
eq(left(comma, mark), null, "child onto the mark's own text");
eq(left(mark, dot), null, "the mark's text into a child");
eq(left(mark, mark), null, "target and relatedTarget the same element");

console.log("\n── moves that leave ───────────────────────────────────────────────");
eq(left(dot, code), mark, "last child out into the block");
eq(left(mark, code), mark, "the mark itself out into the block");
eq(left(comma, null), mark, "relatedTarget null: pointer left the window");
eq(left(dot, other), mark, "into an adjacent mark leaves this one");
eq(left(dot, otherChild), mark, "into an adjacent mark's child leaves this one");
eq(left(link, mark), link, "a docs link into a mark leaves the link");

console.log("\n── not a target at all ────────────────────────────────────────────");
eq(left(code, mark), null, "from plain code into a mark: nothing was left");
eq(left(null, mark), null, "no target");
eq(left(code, null), null, "plain code out of the window");

console.log("\n── the crossing that used to lose the card ────────────────────────");
/* Left to right across the mark: enter `,`, cross to text, cross to `.`, out.
 * The three mouseouts inside 220 ms are the trace; only the last is a leave. */
const crossing = [
  [comma, mark],
  [mark, dot],
  [dot, code],
] as const;
const leaves = crossing.map(([a, b]) => left(a, b)).filter((x) => x !== null);
eq(leaves.length, 1, "one leave for three boundary events");
eq(leaves[0], mark, "and it is the mark");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
