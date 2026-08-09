import type { DfpModule } from "../../core/registry";
import type { DiscourseTopic, PluginApi } from "../types";

const DAY = 86_400_000;
const STALE_AFTER = 365 * DAY;
const BUSY_REPLIES = 25;

/**
 * Adds semantic classes to topic-list rows so the stylesheet can do something
 * useful with them. This is the module that proves the whole chain works —
 * document_start → define trap → initializer → transformer → visible CSS.
 *
 * Every signal here is derivable from the list payload Discourse already
 * fetched, so it costs one extra object read per row and zero requests.
 *
 * Note on scope: "a staff member replied" is deliberately absent. It is the
 * highest-value signal on this forum, but `/latest.json` carries only the last
 * poster and a participant avatar sample — not enough to answer the question
 * truthfully. It needs its own module with its own data source rather than a
 * guess dressed up as a fact.
 */

/** Timestamps only need minute resolution; recomputing per row is waste. */
let nowMs = Date.now();
let clock: ReturnType<typeof setInterval> | undefined;

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function classesFor(topic: DiscourseTopic, now: number): string[] {
  const out: string[] = [];

  if (topic.has_accepted_answer || topic.accepted_answer) out.push("dfp-solved");

  const lastActivity = parseTime(topic.bumped_at) ?? parseTime(topic.last_posted_at);
  if (lastActivity !== null && now - lastActivity > STALE_AFTER) out.push("dfp-stale");

  // There was a `dfp-fresh` signal here for topics created in the last 24h.
  // It was removed after seeing it on the real forum: on /latest, sorted by
  // recency, nearly every row qualified — so the marker appeared on almost
  // everything and told the reader nothing. Discourse's own unread dot already
  // answers the question people actually have ("is this new *to me*").
  //
  // The rule this leaves behind: a signal that fires on most rows is noise,
  // no matter how cheap it is to compute.

  const replies = topic.reply_count ?? (topic.posts_count ?? 1) - 1;
  if (replies >= BUSY_REPLIES) out.push("dfp-busy");

  if (topic.closed) out.push("dfp-closed");

  return out;
}

export function topicListSignals(api: PluginApi): DfpModule {
  return {
    id: "topic-list-signals",
    budgetMs: 4,
    install() {
      nowMs = Date.now();
      clock ??= setInterval(() => {
        nowMs = Date.now();
      }, 60_000);

      api.registerValueTransformer<string[]>("topic-list-item-class", ({ value, context }) => {
        const topic = (context as { topic?: DiscourseTopic }).topic;
        if (!topic) return value;
        // The transformer contract expects the array back; push rather than
        // replace so we compose with anything Discourse or a theme added.
        value.push(...classesFor(topic, nowMs));
        return value;
      });
    },
  };
}
