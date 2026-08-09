/**
 * The current topic's JSON, fetched once and shared.
 *
 * Several modules need the same payload — the accepted answer, post ages, the
 * reply graph — and each fetching its own copy would mean three requests per
 * topic. Discourse renders posts from this data too, but the plugin API does
 * not hand it to a decorator, so the honest options are to read it from the
 * page's Ember store (private, version-fragile) or to ask the server for what
 * the server just sent. This asks.
 *
 * Uses `fetch`, deliberately: the prefetch module patches `XMLHttpRequest`, and
 * routing our own bookkeeping through that patch would let a cache hit for a
 * *page* satisfy a request for *data*.
 */

/** Only the fields DFP actually reads, so a shape change surfaces as a type error. */
export interface TopicPost {
  id: number;
  post_number: number;
  reply_to_post_number: number | null;
  reply_count?: number;
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
  posts_count?: number;
  accepted_answer?: AcceptedAnswer;
  post_stream: {
    posts: TopicPost[];
    /** Every post id in order — the loaded window is only `posts`. */
    stream?: number[];
  };
}

/** `/t/slug/12345` and `/t/12345` both appear; the id is the last number. */
export function topicIdFromPath(pathname: string): number | null {
  const m = /^\/t\/(?:[^/]+\/)?(\d+)/.exec(pathname);
  return m ? Number(m[1]) : null;
}

const cache = new Map<number, Promise<TopicPayload | null>>();

export function getTopic(id: number): Promise<TopicPayload | null> {
  let hit = cache.get(id);
  if (!hit) {
    hit = fetch(`/t/${id}.json`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? (r.json() as Promise<TopicPayload>) : null))
      .catch(() => null);
    cache.set(id, hit);
    // A topic is not immutable — new replies arrive — so this is a
    // within-visit cache, not a durable one. Bounded so a long session of
    // topic-hopping does not accumulate payloads.
    if (cache.size > 12) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return hit;
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
