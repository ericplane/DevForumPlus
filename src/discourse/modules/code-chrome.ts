import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";

/**
 * Controls on code blocks: a language label, wrap, collapse, and a copy that
 * can drop comments.
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
      const bare = button("copy bare", "Copy without comments", "dfp-code-bare");
      bare.addEventListener("click", () => void copy(stripped, bare, "copied"));
      // Immediately before Discourse's copy, so the two copies sit together.
      prepend(bare);
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
    budgetMs: 8,

    install() {
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-code-chrome",
        onlyStream: true,
      });
    },
  };
}
