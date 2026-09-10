/**
 * The current topic's JSON, fetched once and shared.
 *
 * Several modules need the same payload — the accepted answer, post ages, the
 * reply graph — and each fetching its own copy would mean three requests per
 * topic. Discourse renders posts from this data too, but the plugin API does
 * not hand it to a decorator, so the honest options are to read it from the
 * page's Ember store (private, version-fragile) or to ask the server for what
 * the server just sent.
 *
 * Asking was the whole story until the prefetch transport started pushing.
 * Every `/t/{id}.json` and `/t/{id}/{n}.json` Discourse loads goes through its
 * XMLHttpRequest patch, which hands the body here via `primeTopic` from the
 * response's done-state `readystatechange` — an event the XHR spec finishes
 * firing before `load` begins, and `load` is where jQuery resolves the deferred
 * that the route's handlers, the render and every decorator callback hang
 * from. So by the time anything can call `getCurrentTopic`, the body is here.
 * Measured live, the duplicate request this replaces cost one 465ms median
 * TTFB per topic view, and held back the stale banner, thread-view's depths and
 * quiet-replies' fold by exactly that long. `getTopic` still fetches when
 * nothing was primed, so a visit with prefetch disabled or unavailable degrades
 * to what it was. That fallback uses `fetch`, not XHR, on purpose: the
 * transport's entries are single-use, and our bookkeeping must not consume the
 * one Discourse's click is about to ask for.
 */

/** Only the fields DFP actually reads, so a shape change surfaces as a type error. */
export interface TopicPost {
  id: number;
  post_number: number;
  reply_to_post_number: number | null;
  reply_count?: number;
  /** The post's rendered HTML. Only ever read as text — see topic-preview.ts. */
  cooked?: string;
  username?: string;
  name?: string;
  created_at?: string;
  trust_level?: number;
  primary_group_name?: string | null;
  staff?: boolean;
  admin?: boolean;
  moderator?: boolean;
  accepted_answer?: boolean;
}

export interface AcceptedAnswer {
  post_number: number;
  username?: string;
  name?: string;
  excerpt?: string;
}

export interface TopicPayload {
  id: number;
  title?: string;
  created_at?: string;
  /** Verified present on the live payload; drives the staleness mark. */
  last_posted_at?: string;
  posts_count?: number;
  closed?: boolean;
  archived?: boolean;
  accepted_answer?: AcceptedAnswer;
  /**
   * Verified present on `/t/{id}.json`. An id only — the name and colour come
   * from the category table in site-data.ts, one request per visit, so a
   * hover card never asks the server which category a number is.
   */
  category_id?: number;
  post_stream: {
    /**
     * The loaded window only — twenty posts, and not necessarily the first
     * twenty: primed from a deep link, this is the window around the linked
     * post, so even post #1 may be absent. Look posts up by number and treat a
     * miss as "not loaded", never as "does not exist".
     */
    posts: TopicPost[];
    /** Every post id in order — the loaded window is only `posts`. */
    stream?: number[];
  };
}

/**
 * The fields read from `/posts/by_number/{topic}/{n}.json`. Verified on the
 * live route: it answers with id, username, name, created_at, cooked,
 * post_number, reply_count, topic_id and accepted_answer — a different
 * serializer from the stream's, hence a subset rather than a `TopicPost`.
 */
export type PostSummary = Pick<
  TopicPost,
  "id" | "post_number" | "username" | "name" | "created_at" | "cooked"
>;

/**
 * `/t/slug/12345`, `/t/12345`, either optionally followed by `/67`: the topic
 * id in the first group, the post number in the second.
 *
 * The slug arm refuses to match a bare number, which is not fussiness: with a
 * plain `[^/]+/` there, `/t/4301387/3191` parses as topic 3191 — a real topic,
 * and entirely the wrong one. A card that confidently describes a different
 * thread is worse than no card, so the slug has to prove it is a slug.
 *
 * One expression for everything that reads a topic URL — topic-preview.ts
 * marking links, prefetch.ts deciding which JSON to warm, `topicIdFromPath`
 * below — so they cannot disagree about where a link goes. links.test.ts
 * holds it to the cases above.
 */
export const TOPIC_HREF = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?(\d+)(?:\/(\d+))?(?:[/?#]|$)/;

/** The topic id of a topic path, or null for anything that is not one. */
export function topicIdFromPath(pathname: string): number | null {
  const m = TOPIC_HREF.exec(pathname);
  return m ? Number(m[1]) : null;
}

/**
 * A payload on its way, or a body `primeTopic` handed over that nobody has
 * asked for yet. The second is held as text on purpose: the transport sees
 * every topic Discourse loads, and a 51 kB `JSON.parse` per load would run in
 * its listener whether or not any module ever asks — the ask pays instead.
 */
type Entry = Promise<TopicPayload | null> | { text: string };

const cache = new Map<number, Entry>();

/**
 * Newest last, so the cap evicts the least recently stored: a re-store of a
 * topic already present moves it to the back rather than leaving it where it
 * was.
 *
 * A topic is not immutable — new replies arrive — so this is a within-visit
 * cache, not a durable one. Bounded so a long session of topic-hopping does
 * not accumulate payloads.
 */
function store(id: number, entry: Entry): void {
  cache.delete(id);
  cache.set(id, entry);
  if (cache.size > 12) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function fromServer(id: number): Promise<TopicPayload | null> {
  return fetch(`/t/${id}.json`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  })
    .then((r) => (r.ok ? (r.json() as Promise<TopicPayload>) : null))
    .catch(() => null);
}

/**
 * A primed body, parsed one microtask after the ask rather than in it. The
 * asker is usually a decorator callback whose synchronous time decorate.ts
 * charges to its module, and a parse the transport arranged is not that
 * module's work to be struck for.
 *
 * A body that turns out not to be a topic must not answer for the whole visit,
 * so this ask goes to the server as if nothing had been primed, and the
 * server's answer is what stays in the slot.
 */
function fromText(id: number, text: string): Promise<TopicPayload | null> {
  return Promise.resolve()
    .then(() => {
      const parsed = JSON.parse(text) as TopicPayload;
      if (!Array.isArray(parsed?.post_stream?.posts)) throw new Error("not a topic");
      return parsed;
    })
    .catch(() => fromServer(id));
}

export function getTopic(id: number): Promise<TopicPayload | null> {
  const held = cache.get(id);
  if (held instanceof Promise) return held;
  const hit = held ? fromText(id, held.text) : fromServer(id);
  store(id, hit);
  return hit;
}

/**
 * Hand over a topic body someone else already has.
 *
 * Called by the prefetch transport with the text of every topic JSON Discourse
 * loads — served from its cache or seen on the wire — so `getTopic` answers
 * from memory instead of repeating the request. Nothing is parsed here: the
 * text sits as it arrived until the first `getTopic(id)`, so a topic nobody
 * asks about costs the transport one Map entry and no more.
 *
 * The newest body replaces an earlier entry, because it is the one the page is
 * about to render. For a deep link that is the window around the linked post,
 * which is exactly what stale-answer and thread-view need in order to find the
 * posts actually on screen — the head-of-thread window they used to fetch
 * contained none of them.
 */
export function primeTopic(id: number, text: string): void {
  store(id, { text });
}

/**
 * One post by number, from Discourse's single-post route.
 *
 * `post_stream.posts` is one window, so a link to post #3191 of a 9,000-post
 * thread is almost never answerable from `getTopic`. Verified live:
 * `/posts/by_number/{topic}/{n}.json` is a few kB, same-origin with the same
 * cookies, and carries `cooked`, `username` and `created_at` — enough for an
 * excerpt. Not cached here; the one caller keeps what it builds from this
 * under its own key — which is why the two ways this can fail are told apart.
 * A 4xx is the server's answer: deleted, hidden, never existed. That resolves
 * null, and a card without an excerpt is built and kept, so a deleted post is
 * not asked for again on every hover. A 5xx, a 429 or no network is no answer
 * at all, and rejects, so the caller keeps nothing and the next hover asks
 * again — a card built on a blip would otherwise stand for the whole visit.
 */
export function getPost(topicId: number, postNumber: number): Promise<PostSummary | null> {
  return fetch(`/posts/by_number/${topicId}/${postNumber}.json`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  }).then((r) => {
    if (r.ok) return r.json() as Promise<PostSummary>;
    if (r.status === 429 || r.status >= 500) throw new Error(`post ${postNumber}: ${r.status}`);
    return null;
  });
}

/** The topic for the page currently open, or null if this is not a topic page. */
export function getCurrentTopic(): Promise<TopicPayload | null> {
  const id = topicIdFromPath(location.pathname);
  return id === null ? Promise.resolve(null) : getTopic(id);
}

/**
 * Which post is this cooked element part of?
 *
 * Verified on the live forum: `decorateCookedElement` hands us `.cooked`, whose
 * closest `article` carries `id="post_{N}"` and `data-post-id="{dbId}"`. The
 * number in the id is the post *number*, which is what `reply_to_post_number`
 * and `accepted_answer.post_number` refer to — not the database id.
 */
export function postNumberOf(element: HTMLElement): number | null {
  const article = element.closest("article[id^='post_']");
  if (!article) return null;
  const m = /^post_(\d+)$/.exec(article.id);
  return m ? Number(m[1]) : null;
}

/** The `<article>` wrapper, which is what a banner should be inserted into. */
export function articleOf(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>("article[id^='post_']");
}

export function postsByNumber(topic: TopicPayload): Map<number, TopicPost> {
  const map = new Map<number, TopicPost>();
  for (const p of topic.post_stream.posts) map.set(p.post_number, p);
  return map;
}

/** Test seam — the cache is process-wide and would otherwise leak between tests. */
export function clearTopicCache(): void {
  cache.clear();
}
