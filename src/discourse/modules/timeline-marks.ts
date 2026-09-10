import type { DfpModule } from "../../core/registry";
import type { AmdRequire, PluginApi } from "../types";
import { getTopic, topicIdFromPath, type TopicPayload, type TopicPost } from "../topic-data";
import { onDomChange } from "../dom-watch";

/**
 * Staff and solution marks on the timeline rail.
 *
 * post.css gives staff, the OP and the accepted answer a coloured rail so you
 * can "find staff replies by scrolling rather than reading" — but the rail is
 * only visible once the post is on screen, and Discourse keeps a window of
 * about twenty posts loaded (op-pin.ts, thread-view.ts). On a 380-reply Bug
 * Report the reader still scrolls all of it to find the two staff replies. The
 * timeline is the one element that stands for the whole topic, and it carried
 * no marks at all. Now it carries ticks: a link per post that matters, at the
 * height the handle reaches when you are at that post.
 *
 * ── Positioned by post number, like the counter ─────────────────────────────
 * The scrubber's own readout is "82 / 83" — post number over total — and its
 * handle sits at Discourse's `_percentFor` mapping of that number: 0 for the
 * first post, 1 for the last, `index / total` between. `tickPercent` is that
 * mapping, so a tick lands where the handle will be. The total is read off the
 * counter when it is there — it is the same number the handle is scaled by,
 * and it moves when a reply arrives while the payload's does not — with the
 * payload's stream length as the fallback until the rail exists.
 *
 * ── What is known, and only that ────────────────────────────────────────────
 * The solution is `accepted_answer.post_number`, top-level on the payload and
 * so not limited to the loaded window, and its poster is beside it as
 * `accepted_answer.username` (quiet-replies.ts). There is no OP tick: post 1
 * is the top of the rail on every topic, so a tick there says nothing the
 * rail does not and costs a link and a tab stop per topic, and the OP's later
 * replies — a third of a 380-reply thread, the reason post.css keeps that
 * tint light — would bury the two ticks that matter.
 *
 * ── Staff: one filtered request, and every article that renders ────────────
 * The payload names staff for its window only. Its `details.participants`
 * carries `admin`, `moderator` and `primary_group_name` per participant, and
 * Discourse answers `/t/{id}.json?username_filters=a,b,c` with the stream
 * filtered to those posters: `post_stream.posts` is the first twenty of them
 * with `post_number` and flags, and `post_stream.stream` is EVERY matching
 * post id in order. So one same-origin request per topic — made only when the
 * window is not the whole topic — places every staff reply the filter was
 * asked about: twenty by number, and the rest by where their id sits in the
 * unfiltered stream, `index / total`. That is the mapping the handle itself is
 * placed by (the counter counts stream positions), so a tick placed by index
 * is where the handle stops for that post, by construction.
 *
 * Three things the filter does not say, and what covers each. `participants`
 * is the top twenty-four posters by post count (TopicView::MAX_PARTICIPANTS)
 * and is empty on a topic past ten thousand posts, so a staff member with one
 * reply among two hundred participants can be missing from it: the window's
 * own staff posters are added to the filter's names, and every article that
 * scrolls in is read regardless, so a staff reply the filter never asked
 * about appears as you pass it — the moment the post rail would have shown it
 * — and the tick stays. An id beyond the filtered window has no `post_type`,
 * so a moderator's own "closed" row (a small action) would tick; when its
 * article renders it carries `data-post-id`, and a projected id whose article
 * is a small action is dropped, while a real post is re-keyed by its number.
 * And a position is not a number: the counter reads the stream position at
 * that height, which is the post number unless a post before it was deleted,
 * so a projected tick is titled with the position — what the rail itself says
 * there — and linked by id, `/p/{id}`, which the server redirects to the
 * post's permalink.
 *
 * ── Why the layer is prepended, and a click is routed by hand ───────────────
 * `.timeline-scrollarea` is `position: relative` and holds the paddings and
 * the scroller in flow. The marks are an absolutely positioned layer with
 * `pointer-events: none`, ticks opting back in, so the drag handle is never
 * obstructed by the layer itself. Where a tick and the handle coincide — a
 * staff opening post while the reader is at post 1, or any tick at the post
 * the reader is on — the handle must win: a tick there is a link to where you
 * already are, and a mousedown it caught would start no drag. An absolutely
 * positioned tick paints and takes the pointer above an in-flow sibling
 * whatever the DOM order, so timeline-marks.css positions the scroller too
 * (`position: relative`, no offsets — its geometry is untouched) and the layer
 * is inserted FIRST: two positioned siblings at `z-index: auto` paint in DOM
 * order, and the later scroller is the one hit where they overlap. The
 * scrollarea also jumps on its own click, computed from the pointer's height,
 * so a tick's click is stopped there and sent through `DiscourseURL.routeTo`
 * instead: one jump, to the post the tick names, and the anchor keeps a real
 * href for the middle button and the address bar. `touchend` is stopped on a
 * tick as well: whether this build's scrollarea jumps on it is unmeasured, and
 * one listener is cheaper than a tap that jumps twice. The tap's own click
 * still arrives and routes, since nothing is prevented.
 * ───────────────────────────────────────────────────────────────────────────
 */

const LAYER = "dfp-timeline-marks";
const TICK = "dfp-timeline-mark";
/** Read by timeline-marks.css as the tick's vertical position, 0..1. */
const PCT_VAR = "--dfp-tl-pct";
const ARTICLE = "article[id^='post_']";
/**
 * Records per batch above which one document query beats a walk of the
 * batch. Glimmer appends a post's nodes one by one into a connected parent,
 * so a page of twenty posts arrives as thousands of records and a subtree
 * query per added element would cost more than the ~0.3 ms one query over
 * 550 articles does; the small batches the rail and the relative dates emit
 * on every scroll are the ones the walk is for.
 */
const ADDED_CAP = 200;

export type MarkKind = "solved" | "staff";

export interface Mark {
  /**
   * The post number — or, for a post known only from the filtered stream, its
   * 1-based stream position: the number the rail's counter shows at that
   * height, and the post number itself unless a post before it was deleted.
   */
  n: number;
  /** Set on a position-only mark: the database id, which the href goes by. */
  id?: number;
  /** Strongest first, and the first is the colour the tick takes. */
  kinds: MarkKind[];
  who: string | null;
}

/** A staff post placed by stream position, before its article has rendered. */
export interface Projected {
  pos: number;
  who: string;
}

/** Solution outranks staff — the order post.css resolves the rails in. */
const STRENGTH: readonly MarkKind[] = ["solved", "staff"];

const KIND_LABEL: Record<MarkKind, string> = {
  solved: "solution",
  staff: "staff",
};

// ── Position math ───────────────────────────────────────────────────────────

/**
 * Where post `n` of `total` sits on the rail, 0..1.
 *
 * Discourse's `_percentFor` in the topic-timeline component: the first post is
 * pinned to 0 and the last to 1 so the handle touches both ends, and anything
 * between is `index / total` with index = n − 1. The handle's top edge is
 * `pct × (height − 50)` and the tick is drawn at `pct × height`, which puts the
 * tick inside the handle's 50px whenever the handle is at that post, for any
 * pct in [0, 1] — timeline-marks.test.ts holds the invariant. A post number
 * past the total (deleted posts leave gaps, so numbers can exceed the count)
 * clamps to the end rather than drawing outside the box.
 */
export function tickPercent(n: number, total: number): number {
  if (!(total > 1) || !(n > 1)) return 0;
  if (n >= total) return 1;
  return (n - 1) / total;
}

/**
 * The total from the scrubber's "82 / 83" readout, or null when there is no
 * readable one. Digits after the slash only, with the thousands separators
 * Discourse prints on a big topic ("5,795 / 9,174") dropped.
 */
export function counterTotal(text: string | null | undefined): number | null {
  if (!text) return null;
  const slash = text.indexOf("/");
  if (slash < 0) return null;
  const digits = text.slice(slash + 1).replace(/\D/g, "");
  if (!digits) return null;
  const total = Number(digits);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * `/t/slug/id/n` when the slug is known, `/t/id/n` otherwise — Discourse
 * redirects the short form to the long one, and both route the same way.
 */
export function postHref(slug: string | null | undefined, id: number, n: number): string {
  return slug ? `/t/${slug}/${id}/${n}` : `/t/${id}/${n}`;
}

/**
 * The tick's href: the post's permalink by number, or `/p/{id}` for a mark
 * that knows only its position — the server answers that with a redirect to
 * the permalink, so the click lands on the right post whatever the gaps.
 */
export function tickHref(slug: string | null | undefined, topicId: number, mark: Mark): string {
  return mark.id !== undefined ? `/p/${mark.id}` : postHref(slug, topicId, mark.n);
}

// ── The model ───────────────────────────────────────────────────────────────

export interface MarkSource {
  solved: number | null;
  /** Staff post numbers, each with the poster's username where it is known. */
  staff: ReadonlyMap<number, string>;
  /** Usernames by post number, for the solution's title when its poster is known. */
  names?: ReadonlyMap<number, string>;
  /** Staff posts placed by stream position only, keyed by database id. */
  projected?: ReadonlyMap<number, Projected>;
}

/**
 * One mark per post that matters, ascending, kinds strongest first.
 *
 * A post can be both things at once — the solution written by staff — and
 * gets one tick coloured by the stronger, with both roles named in the title.
 * A position-only post whose position is a number already drawn is taken to
 * be that post: the two coincide unless a post before them was deleted, and
 * two ticks at one height would say nothing a merged one does not.
 */
export function marksFrom(src: MarkSource): Mark[] {
  const kinds = new Map<number, Set<MarkKind>>();
  const add = (n: number, kind: MarkKind) => {
    if (!Number.isFinite(n) || n < 1) return;
    let set = kinds.get(n);
    if (!set) kinds.set(n, (set = new Set()));
    set.add(kind);
  };
  if (src.solved !== null) add(src.solved, "solved");
  for (const n of src.staff.keys()) add(n, "staff");

  const byNumber = new Map<number, Mark>();
  for (const [n, set] of kinds) {
    byNumber.set(n, {
      n,
      kinds: STRENGTH.filter((k) => set.has(k)),
      who: src.staff.get(n) || src.names?.get(n) || null,
    });
  }

  const marks = [...byNumber.values()];
  for (const [id, { pos, who }] of src.projected ?? []) {
    if (!Number.isFinite(pos) || pos < 1) continue;
    const same = byNumber.get(pos);
    if (same) {
      if (!same.kinds.includes("staff")) same.kinds.push("staff");
      if (!same.who && who) same.who = who;
    } else {
      marks.push({ n: pos, id, kinds: ["staff"], who: who || null });
    }
  }
  return marks.sort((a, b) => a.n - b.n);
}

/** "#42 · Bluff_006 · staff", or "#17 · solution, staff" when the name is unknown. */
export function tickTitle(mark: Mark): string {
  const parts = [`#${mark.n}`];
  if (mark.who) parts.push(mark.who);
  parts.push(mark.kinds.map((k) => KIND_LABEL[k]).join(", "));
  return parts.join(" · ");
}

/**
 * Staff, by every flag the payload carries — the same "matched several ways"
 * rule post.css follows, because a staff member whose primary group is not
 * Roblox_Staff, or who is a moderator without `staff`, exists in the wild and
 * missing them is the worst failure this signal has.
 *
 * Small actions are refused before the flags are read. Discourse serialises
 * `admin`, `moderator` and `staff` for every post type, and its `system` user
 * (id −1) is seeded admin and moderator — so the "This topic was automatically
 * closed N days after the last reply" row that ends most DevForum topics
 * arrived as staff, and nearly every closed topic grew a purple tick titled
 * "#N · system · staff" at its foot: the exact "Roblox replied" false positive
 * post.css names as the worst failure here, on a row the post rail never
 * colours (a small action is not `article.boxed`). Post types: 1 regular, 2
 * moderator action, 3 small action, 4 whisper. Type 2 is kept — a staff
 * member's own close-with-message post renders as a normal post and is theirs
 * — and `system` is refused whatever the type, since nothing it posts is a
 * person replying. `post_type` is on the live payload but not `TopicPost`,
 * which lists only what the shared readers use, so it is read as optional the
 * way `slug` is below.
 */
export function isStaffPost(p: TopicPost): boolean {
  const type = (p as TopicPost & { post_type?: unknown }).post_type;
  if (type === 3 || p.username === "system") return false;
  return !!(p.staff || p.admin || p.moderator || p.primary_group_name === "Roblox_Staff");
}

// ── Reading the payload ─────────────────────────────────────────────────────

/** The fields of a `details.participants` entry read here; all optional on the wire. */
export interface Participant {
  username?: unknown;
  admin?: unknown;
  moderator?: unknown;
  primary_group_name?: unknown;
}

/**
 * The usernames the filter is asked for: every participant the payload flags
 * as admin, moderator or Roblox_Staff, plus every staff poster in the loaded
 * window — the second covers the top-twenty-four cap on the first. `system`
 * is left out for the reason `isStaffPost` refuses it; a filtered window that
 * spent its twenty posts on auto-close rows would answer nothing.
 */
export function staffNames(participants: unknown, windowPosts: readonly TopicPost[]): string[] {
  const out = new Set<string>();
  if (Array.isArray(participants)) {
    for (const raw of participants as Participant[]) {
      const name = raw?.username;
      if (typeof name !== "string" || !name || name === "system") continue;
      if (raw.admin === true || raw.moderator === true || raw.primary_group_name === "Roblox_Staff") {
        out.add(name);
      }
    }
  }
  for (const p of windowPosts) {
    if (p.username && isStaffPost(p)) out.add(p.username);
  }
  return [...out];
}

export interface PayloadFacts {
  slug: string | null;
  /** The counter's total: the stream length, or `posts_count` without a stream. */
  total: number;
  solved: number | null;
  names: Map<number, string>;
  staff: Map<number, string>;
  /** Database ids of the window's posts — placed by number, never projected. */
  ids: Set<number>;
  stream: number[];
  /** True when the window is not the whole topic, so a filter can find more. */
  partial: boolean;
  filterNames: string[];
}

/**
 * Everything a payload says about which posts matter, in one pure read.
 *
 * `slug` and `details` are on the live payload (types.ts names the slug on
 * the list-row shape) but not on `TopicPayload`, which lists only what the
 * shared readers use; both are read as optional and the short href stands in
 * when the slug is absent. The solution's poster is taken from
 * `accepted_answer.username` when the window does not hold the post, which on
 * a long topic it usually does not: without it the tick read "#17 · solution"
 * until the reader scrolled past post 17.
 */
export function fromPayload(topic: TopicPayload): PayloadFacts {
  const extra = topic as TopicPayload & { slug?: unknown; details?: { participants?: unknown } };
  const rawSlug = extra.slug;
  const stream = Array.isArray(topic.post_stream.stream) ? topic.post_stream.stream : [];
  const posts = topic.post_stream.posts;
  const names = new Map<number, string>();
  const staff = new Map<number, string>();
  const ids = new Set<number>();
  for (const p of posts) {
    ids.add(p.id);
    if (p.username) names.set(p.post_number, p.username);
    if (isStaffPost(p)) staff.set(p.post_number, p.username ?? "");
  }
  const solved = topic.accepted_answer?.post_number ?? null;
  const solver = topic.accepted_answer?.username;
  if (solved !== null && solver && !names.has(solved)) names.set(solved, solver);
  const total = stream.length || topic.posts_count || 0;
  return {
    slug: typeof rawSlug === "string" && rawSlug ? rawSlug : null,
    total,
    solved,
    names,
    staff,
    ids,
    stream,
    partial: total > posts.length,
    filterNames: staffNames(extra.details?.participants, posts),
  };
}

/**
 * The filtered stream's ids that nothing else has placed, by their 1-based
 * position in the unfiltered stream. One walk of the stream with a Set lookup
 * per id, stopping once every wanted id is found — no id-to-index table of
 * nine thousand entries for the two or three ids that need one. An id the
 * stream does not hold (a post that became invisible between the two
 * responses) is left out rather than guessed.
 */
export function projectIds(
  filtered: readonly number[],
  stream: readonly number[],
  skip: ReadonlySet<number>,
  who: string,
): Map<number, Projected> {
  const wanted = new Set<number>();
  for (const id of filtered) if (!skip.has(id)) wanted.add(id);
  const out = new Map<number, Projected>();
  for (let i = 0; i < stream.length && out.size < wanted.size; i++) {
    const id = stream[i];
    if (id !== undefined && wanted.has(id)) out.set(id, { pos: i + 1, who });
  }
  return out;
}

// ── Reading the DOM ─────────────────────────────────────────────────────────

/**
 * The post's OWN byline. An article also contains the bylines of embedded
 * replies (`.topic-meta-data.embedded-reply`, expanded above or below the
 * post), and the `top` section renders before the post's own row, so a bare
 * `.topic-meta-data` query would read a quoted staff reply as the post's
 * author — stale-answer.ts found the same trap. The chain is the measured one:
 * `article > .row > .topic-body > .topic-meta-data`.
 */
function ownByline(article: Element): Element | null {
  return (
    article.querySelector(":scope > .row > .topic-body > .topic-meta-data") ??
    article.querySelector(".topic-meta-data:not(.embedded-reply)")
  );
}

/** The markers post.css keys the staff rail on, applied to one byline. */
const STAFF_IN_BYLINE = [
  ".names .staff",
  ".names .admin",
  ".names .moderator",
  ".names [class*='group--Roblox_Staff']",
  ".user-title--roblox-staff",
  "a.user-group[href='/g/Roblox_Staff']",
].join(", ");

function articleIsStaff(article: Element, byline: Element | null): boolean {
  if (article.closest(".topic-post")?.classList.contains("group-Roblox_Staff")) return true;
  const cl = article.classList;
  if (cl.contains("staff") || cl.contains("admin") || cl.contains("moderator")) return true;
  return !!byline?.querySelector(STAFF_IN_BYLINE);
}

function usernameOf(byline: Element | null): string {
  if (!byline) return "";
  const card = byline.querySelector(".names a[data-user-card]");
  const fromCard = card?.getAttribute("data-user-card")?.trim();
  if (fromCard) return fromCard;
  return byline.querySelector(".names a")?.textContent?.trim() ?? "";
}

function postNumberOfArticle(article: Element): number | null {
  const m = /^post_(\d+)$/.exec(article.id);
  return m ? Number(m[1]) : null;
}

// ── State, per topic ────────────────────────────────────────────────────────

let currentTopic: number | null = null;
/**
 * Bumped by every reset. A load compares it after each await instead of
 * re-reading `currentTopic`: A → B → A in quick succession leaves the id
 * equal while the first load's answer belongs to a visit that was cleared,
 * and two loads for one claim would be two filtered requests for one topic.
 */
let generation = 0;
let slug: string | null = null;
/** The stream length from the payload; the counter overrides it at render time. */
let payloadTotal = 0;
let solved: number | null = null;
const staff = new Map<number, string>();
const names = new Map<number, string>();
const projected = new Map<number, Projected>();
/** Articles already read, by post number, so a pass costs one Set lookup per article. */
const seen = new Set<number>();
/** The same articles by database id, so a filtered answer never re-places one. */
const seenIds = new Set<number>();

/** The model changed since the layer was last built. */
let dirty = true;
/** The total the current layer was scaled to. */
let renderedTotal = 0;

function reset(): void {
  generation++;
  slug = null;
  payloadTotal = 0;
  solved = null;
  staff.clear();
  names.clear();
  projected.clear();
  seen.clear();
  seenIds.clear();
  dirty = true;
  renderedTotal = 0;
  document.querySelector(`.${LAYER}`)?.remove();
}

/**
 * Key everything to the topic open now; answer whether that changed.
 *
 * Called from the watcher as well as `onPageChange`, because the first DOM
 * batch of a new topic can be flushed before Discourse fires the hook, and
 * post numbers are per-topic — a staff #12 read into the previous topic's set
 * would draw a confident tick on the wrong thread. Cleared BEFORE the await,
 * the discipline thread-view.ts and op-pin.ts arrived at for the same reason.
 */
function claimTopic(): boolean {
  const id = topicIdFromPath(location.pathname);
  if (id === currentTopic) return false;
  currentTopic = id;
  reset();
  if (id !== null) void loadTopic(id, generation);
  return true;
}

async function loadTopic(id: number, gen: number): Promise<void> {
  const topic = await getTopic(id);
  // A newer navigation already cleared this visit; the answer is stale.
  if (!topic || generation !== gen) return;

  const facts = fromPayload(topic);
  slug = facts.slug;
  payloadTotal = facts.total;
  solved = facts.solved;
  for (const [n, who] of facts.names) if (!names.has(n)) names.set(n, who);
  for (const [n, who] of facts.staff) staff.set(n, who);
  dirty = true;
  render();

  /* The one extra request, and only when it can find something: on a topic
   * the window covers whole — most of the forum — the payload has already
   * named every staff reply, and with nobody to filter for there is nothing
   * to ask. */
  if (facts.partial && facts.filterNames.length) await loadFiltered(id, gen, facts);
}

async function loadFiltered(id: number, gen: number, facts: PayloadFacts): Promise<void> {
  const qs = facts.filterNames.map(encodeURIComponent).join(",");
  /* `fetch`, not XHR, for the reason topic-data.ts gives: the prefetch
   * transport patches XMLHttpRequest and must not see this as a topic load. */
  const res = await fetch(`/t/${id}.json?username_filters=${qs}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  }).catch(() => null);
  if (!res?.ok || generation !== gen) return;
  const data = (await res.json().catch(() => null)) as {
    post_stream?: { posts?: TopicPost[]; stream?: number[] };
  } | null;
  if (generation !== gen) return;
  const posts = data?.post_stream?.posts;
  if (!Array.isArray(posts)) return;

  /* The filter always includes post 1 whoever wrote it, and a moderator's
   * small actions are theirs too; `isStaffPost` draws the same line here as
   * for the payload's own window. */
  const known = new Set(facts.ids);
  for (const p of posts) {
    known.add(p.id);
    if (p.username && !names.has(p.post_number)) names.set(p.post_number, p.username);
    if (isStaffPost(p)) staff.set(p.post_number, p.username ?? "");
  }

  const filtered = data?.post_stream?.stream;
  if (Array.isArray(filtered) && facts.stream.length) {
    for (const sid of seenIds) known.add(sid);
    // The filtered stream does not say which of several names wrote which id.
    const who = facts.filterNames.length === 1 ? (facts.filterNames[0] ?? "") : "";
    for (const [pid, entry] of projectIds(filtered, facts.stream, known, who)) projected.set(pid, entry);
  }
  dirty = true;
  render();
}

/**
 * Read one article not read before; staff found here join the set for good.
 *
 * "For good" is why each unseen article has to prove it belongs to the topic
 * claimed. Ember flips the URL and re-renders in one runloop, but a DOM batch
 * flushed inside that window shows the previous topic's posts under the new
 * topic's path, and a staff #12 filed from them would not only draw a wrong
 * tick — `seen` would then refuse the real #12 when it rendered, so the tick
 * would stay for the visit. The byline's date link is the post's permalink and
 * names its topic; the anchor's resolved `pathname` is read rather than the
 * attribute parsed, because a `URL` constructor throws on a malformed href
 * and the throw would leave the article unseen to throw again on every batch.
 * A mismatch is left unread for the pass that finds it gone.
 */
function readArticle(article: Element): void {
  const n = postNumberOfArticle(article);
  if (n === null || seen.has(n)) return;
  const byline = ownByline(article);
  const link = byline?.querySelector<HTMLAnchorElement>(".post-infos a.post-date");
  if (link?.getAttribute("href") && topicIdFromPath(link.pathname) !== currentTopic) return;
  seen.add(n);

  /* The article settles a projection made for its id: the post is now placed
   * by number below, or is a row and was never a reply. */
  const id = Number(article.getAttribute("data-post-id"));
  if (id > 0) {
    seenIds.add(id);
    if (projected.delete(id)) dirty = true;
  }

  /* A small action — "closed", "pinned", "unlisted", the auto-close notice —
   * is `article#post_N` too (quiet-replies.ts walks past them for the same
   * reason) and sits in a `.topic-post` wrapper that carries the actor's
   * group class, so the staff test below would read a moderator closing a
   * thread as a staff reply. It is a row, not a post: counted as seen, never
   * as staff, the same line `isStaffPost` draws for the payload. */
  if (article.classList.contains("small-action")) return;

  const who = usernameOf(byline);
  if (who && !names.has(n)) names.set(n, who);
  if (articleIsStaff(article, byline) && !staff.has(n)) {
    staff.set(n, who);
    dirty = true;
  }
}

function scanAll(): void {
  for (const article of document.querySelectorAll(ARTICLE)) readArticle(article);
}

/**
 * Only what the batch added. Deep in a long topic the stream only grows
 * (op-pin.ts: post 1 still present at reply #543 of 9,163), so a document
 * query per batch walked hundreds of articles for a Set lookup each, on the
 * exact threads the ticks are for; the small batches the rail emits on every
 * scroll now cost a few `matches` calls and nothing else.
 */
function scanAdded(records: MutationRecord[]): void {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      if (el.matches(ARTICLE)) readArticle(el);
      else for (const article of el.querySelectorAll(ARTICLE)) readArticle(article);
    }
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function routeTo(href: string): boolean {
  const req = window.require as AmdRequire | undefined;
  if (typeof req !== "function") return false;
  try {
    const mod = req("discourse/lib/url") as
      | { default?: { routeTo?: (url: string) => unknown } }
      | undefined;
    const url = mod?.default;
    if (typeof url?.routeTo !== "function") return false;
    url.routeTo(href);
    return true;
  } catch {
    return false;
  }
}

function onTickClick(e: MouseEvent): void {
  /* The scrollarea beneath jumps on its own click, from the pointer's height;
   * a click that reached it as well would jump twice. A modified click keeps
   * its default — a new tab is what the reader asked for — and only the plain
   * one is routed here. */
  e.stopPropagation();
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = (e.currentTarget as HTMLAnchorElement).getAttribute("href");
  /* Only a topic path is routed in-app. `/p/{id}` is the server's to resolve:
   * the Ember router has no route for it and would hand it to the unknown
   * route's permalink check, so it is left to navigate — a full load, for a
   * tick past the filtered window, to the right post. */
  if (href?.startsWith("/t/") && routeTo(href)) e.preventDefault();
  // Otherwise the anchor navigates on its own: a full load, but the right page.
}

function stopTouch(e: Event): void {
  e.stopPropagation();
}

function buildTick(topicId: number, mark: Mark, total: number): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = `${TICK} ${TICK}--${mark.kinds[0]}`;
  a.href = tickHref(slug, topicId, mark);
  const title = tickTitle(mark);
  a.title = title;
  a.setAttribute("aria-label", title);
  a.style.setProperty(PCT_VAR, tickPercent(mark.n, total).toFixed(4));
  a.addEventListener("click", onTickClick);
  a.addEventListener("touchend", stopTouch);
  return a;
}

/**
 * Build or refresh the layer, when there is something new to show.
 *
 * Runs once per DOM batch, so the early returns are the cost that matters: an
 * unchanged model against a connected layer scaled to the counter's total is
 * one query and two comparisons. The layer is rebuilt from scratch otherwise —
 * a handful of anchors — rather than diffed.
 */
function render(): void {
  const topicId = currentTopic;
  if (topicId === null) return;
  const area = document.querySelector<HTMLElement>(".topic-timeline .timeline-scrollarea");
  if (!area) return;

  const total = counterTotal(area.querySelector(".timeline-replies")?.textContent) ?? payloadTotal;
  let layer = area.querySelector<HTMLElement>(`:scope > .${LAYER}`);
  if (layer && !dirty && total === renderedTotal) return;

  if (total < 1) {
    // Nothing to scale against yet — the payload has not landed and the rail
    // has no counter. Better no ticks than ticks at a guessed height.
    layer?.remove();
    return;
  }

  if (!layer) {
    layer = document.createElement("div");
    layer.className = LAYER;
    area.prepend(layer);
  }
  const ticks = marksFrom({ solved, staff, names, projected }).map((m) => buildTick(topicId, m, total));
  layer.replaceChildren(...ticks);
  dirty = false;
  renderedTotal = total;
}

/**
 * One pass: claim the topic, read what is new, draw. The whole document is
 * read only when the claim just changed or the caller has no batch to go by
 * (a route change, install); a batch too large to walk is the other case,
 * for the reason `ADDED_CAP` gives.
 */
function pass(records?: MutationRecord[]): void {
  const changed = claimTopic();
  if (currentTopic === null) return;
  if (changed || !records || records.length > ADDED_CAP) scanAll();
  else scanAdded(records);
  render();
}

export function timelineMarks(api: PluginApi): DfpModule {
  return {
    id: "timeline-marks",
    /* A pass is a walk of the batch's added nodes, or one article query plus a
     * Set lookup per post on screen after a route change, and a rebuild is a
     * handful of anchors; the number is an alarm, well above that, as
     * registry.ts asks. */
    budgetMs: 80,

    install() {
      api.onPageChange(() => pass());

      /* Posts arrive as you scroll, and Discourse rebuilds the rail when the
       * viewport crosses its docked and fullscreen modes, so both "which posts
       * are known" and "is the layer still there" change without a route
       * change. `childList` only: the writes here are a prepended layer, which
       * the guard in `render` recognises on the next batch, and an inline
       * custom property, which the observer does not watch. */
      onDomChange((records) => pass(records));

      pass();
    },
  };
}
