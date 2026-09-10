/**
 * "Does this text look like Luau?" — the sniff that decides whether an
 * unfenced block gets Luau treatment, and now whether a paste into the
 * composer is offered a fence.
 *
 * It lives here, dependency-free, because two worlds need the same answer:
 * code-intel.ts in the MAIN world reads posts, composer.ts in the ISOLATED
 * world watches the editor. A copy in each would drift, and the history of this
 * test (see END_KEYWORD) is exactly the kind of thing that drifts.
 */

/**
 * Structure only Luau has. Any one of these is enough on its own.
 *
 * A local declaration that assigns or annotates, a `:GetService(` call, or a
 * long comment — none of which survive being read as any other language in a
 * `<pre>`.
 */
export const LUAU_SIGNALS: readonly RegExp[] = [
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
export const BLOCK_OPENER =
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
export const END_KEYWORD = /(?<![,([=:"'][ \t]{0,8})\bend\b(?![ \t]*[=({[.:])/;

/**
 * True when `text` is Luau by structure, not by vocabulary.
 *
 * The two halves used to share an alternation —
 * `/\b(local|function|end|then|elseif)\b/ && /\bend\b/` — and because `end`
 * appeared in both, the whole expression reduced to `/\bend\b/`. It claimed
 * `return line[start:end]`, `str.slice(start, end)`,
 * `WHERE id BETWEEN start AND end;` and the English sentence "read the thread
 * to the end please", painting each as Luau and hanging fake deprecation marks
 * on any `spawn` or `wait` in them — while rejecting
 * `local Players = game:GetService("Players")` for not containing `end`.
 * Keep the signals disjoint: a bare `end` proves nothing by itself.
 */
export function looksLikeLuauText(text: string): boolean {
  if (text.length < 12) return false;
  if (LUAU_SIGNALS.some((re) => re.test(text))) return true;
  return BLOCK_OPENER.test(text) && END_KEYWORD.test(text);
}
