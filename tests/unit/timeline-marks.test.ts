import {
  counterTotal,
  fromPayload,
  isStaffPost,
  marksFrom,
  postHref,
  projectIds,
  staffNames,
  tickHref,
  tickPercent,
  tickTitle,
} from "../../src/discourse/modules/timeline-marks";
import type { TopicPayload, TopicPost } from "../../src/discourse/topic-data";

/**
 * The position math under the timeline ticks, and the model they are drawn
 * from.
 *
 * A tick is a claim — "a staff reply is HERE" — made on a rail the reader
 * trusts to be the whole topic, so a tick in the wrong place is worse than no
 * tick. The mapping is Discourse's own (first post at 0, last at 1, `index /
 * total` between) and the property that matters is checked directly: wherever
 * the handle stops for post N, the tick for N is inside it. The rest is the
 * reading of the counter the total comes from, the href a tick points at, the
 * rule for a post that is two things at once, and the two pure reads behind
 * the filtered request: who the payload says to ask for, and where an id the
 * filter returned sits in the unfiltered stream.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

console.log("── tickPercent ───────────────────────────────────────────────────");
eq(tickPercent(1, 83), 0, "the first post is pinned to the top");
eq(tickPercent(83, 83), 1, "the last post is pinned to the bottom");
eq(tickPercent(42, 83), 41 / 83, "between: (n − 1) / total, as Discourse scales the handle");
eq(tickPercent(90, 83), 1, "a number past the count (deleted posts leave gaps) clamps to the end");
eq(tickPercent(1, 1), 0, "a one-post topic has nothing to scale: top");
eq(tickPercent(1, 0), 0, "no total yet: top, never NaN");
eq(tickPercent(5, 0), 0, "no total, any post: still a number in range");
check(!Number.isNaN(tickPercent(NaN, 10)) && tickPercent(NaN, 10) === 0, "a NaN post number answers 0");

{
  /* The invariant the layout rests on. Discourse's handle is 50px tall and
   * its top edge sits at pct × (height − 50); the tick is drawn at pct × height.
   * For every post of a topic, at the rail's smallest and largest heights
   * (interactive.css: 170..300px), the tick must fall within the handle. */
  const SCROLLER = 50;
  let inside = true;
  for (const height of [170, 300]) {
    for (const total of [2, 3, 20, 83, 9174]) {
      for (let n = 1; n <= total; n++) {
        const pct = tickPercent(n, total);
        const handleTop = pct * (height - SCROLLER);
        const tick = pct * height;
        if (tick < handleTop || tick > handleTop + SCROLLER) inside = false;
        if (pct < 0 || pct > 1) inside = false;
      }
    }
  }
  check(inside, "every tick lies inside the handle when the handle is at that post (170px and 300px rails)");
}

console.log("── counterTotal ──────────────────────────────────────────────────");
eq(counterTotal("82 / 83"), 83, "the readout as Discourse renders it");
eq(counterTotal("5,795 / 9,174"), 9174, "thousands separators dropped");
eq(counterTotal("  1 / 1 "), 1, "whitespace around");
eq(counterTotal("83"), null, "no slash: not the readout, no guess");
eq(counterTotal("82 / "), null, "nothing after the slash");
eq(counterTotal(""), null, "empty");
eq(counterTotal(null), null, "no element");
eq(counterTotal(undefined), null, "no text");

console.log("── postHref ──────────────────────────────────────────────────────");
eq(postHref("completing-the-dynamic-head-migration", 4301387, 3191),
  "/t/completing-the-dynamic-head-migration/4301387/3191", "slug form, the one Discourse renders");
eq(postHref(undefined, 4301387, 1), "/t/4301387/1", "no slug yet: the short form Discourse redirects");
eq(postHref("", 4301387, 1), "/t/4301387/1", "an empty slug is no slug");
eq(postHref(null, 12, 3), "/t/12/3", "null slug");

console.log("── tickHref ──────────────────────────────────────────────────────");
eq(tickHref("a-slug", 4301387, { n: 42, kinds: ["staff"], who: null }),
  "/t/a-slug/4301387/42", "a numbered mark links by number");
eq(tickHref("a-slug", 4301387, { n: 300, id: 987654, kinds: ["staff"], who: null }),
  "/p/987654", "a position-only mark links by id, which the server redirects to the permalink");

console.log("── marksFrom ─────────────────────────────────────────────────────");
{
  const marks = marksFrom({ solved: null, staff: new Map() });
  eq(marks.length, 0, "with nothing known there is nothing to draw — no OP tick, post 1 is the top of the rail");
}
{
  const marks = marksFrom({
    solved: 17,
    staff: new Map([
      [31, "Bluff_006"],
      [4, "Cactus_Cat"],
    ]),
    names: new Map([[1, "ArawDev"]]),
  });
  eq(marks.map((m) => m.n).join(","), "4,17,31", "ascending by post number, and no entry for post 1");
  eq(marks[0]?.who, "Cactus_Cat", "a staff name comes with the staff entry");
  eq(marks[1]?.kinds.join(","), "solved", "the solution");
  eq(marks[1]?.who, null, "…unnamed when nobody knows the poster");
}
{
  const marks = marksFrom({ solved: 17, staff: new Map(), names: new Map([[17, "ashenix_dev"]]) });
  eq(marks[0]?.who, "ashenix_dev", "the solution's name comes from the names map");
}
{
  const marks = marksFrom({ solved: 9, staff: new Map([[9, "Bluff_006"]]) });
  eq(marks.length, 1, "one post that is both things gets one tick");
  eq(marks[0]?.kinds.join(","), "solved,staff", "kinds strongest first: solution, then staff");
  eq(marks[0]?.who, "Bluff_006", "and the staff name");
}
{
  const marks = marksFrom({ solved: 1, staff: new Map([[1, "Bluff_006"]]) });
  eq(marks.map((m) => m.n).join(","), "1", "a staff opening post is still a staff tick, at the top");
}
{
  const marks = marksFrom({ solved: 0, staff: new Map([[-3, "x"], [NaN, "y"]]) });
  eq(marks.length, 0, "post numbers below 1 and NaN are refused");
}
{
  // Staff whose name the DOM could not read: the entry is kept, the name falls
  // through to the names map, then to nothing.
  const marks = marksFrom({ solved: null, staff: new Map([[8, ""]]), names: new Map([[8, "seen_later"]]) });
  eq(marks[0]?.who, "seen_later", "an empty staff name defers to the names map");
}
{
  // Projected: a staff post past the filtered window, known by id and stream
  // position only, drawn as a staff tick at that position with the id kept
  // for the href.
  const marks = marksFrom({
    solved: 17,
    staff: new Map([[4, "Cactus_Cat"]]),
    projected: new Map([[987654, { pos: 300, who: "Bluff_006" }]]),
  });
  eq(marks.map((m) => m.n).join(","), "4,17,300", "a projected post sorts by its position among the numbered ones");
  eq(marks[2]?.id, 987654, "…and carries the id");
  eq(marks[2]?.kinds.join(","), "staff", "…as a staff tick");
  eq(marks[2]?.who, "Bluff_006", "…named when the filter had one name");
  eq(marks[0]?.id, undefined, "a numbered mark has no id");
}
{
  const marks = marksFrom({ solved: 300, staff: new Map(), projected: new Map([[5, { pos: 300, who: "" }]]) });
  eq(marks.length, 1, "a projection at a number already drawn is merged, not drawn twice");
  eq(marks[0]?.kinds.join(","), "solved,staff", "…and the merged tick names both roles, strongest first");
  eq(marks[0]?.id, undefined, "…keeping the numbered href");
  eq(marks[0]?.who, null, "an empty projected name adds nothing");
}
{
  const marks = marksFrom({ solved: null, staff: new Map(), projected: new Map([[5, { pos: 0, who: "x" }], [6, { pos: NaN, who: "y" }]]) });
  eq(marks.length, 0, "projected positions below 1 and NaN are refused");
}

console.log("── staffNames ────────────────────────────────────────────────────");
{
  const win: TopicPost[] = [
    { id: 1, post_number: 1, reply_to_post_number: null, username: "ArawDev" },
    { id: 9, post_number: 9, reply_to_post_number: null, username: "Cactus_Cat", staff: true },
  ];
  const participants = [
    { username: "ArawDev", trust_level: 2 },
    { username: "Bluff_006", admin: true },
    { username: "mod_person", moderator: true },
    { username: "flair_only", primary_group_name: "UI_Designers" },
    { username: "quiet_staff", primary_group_name: "Roblox_Staff" },
    { username: "system", admin: true, moderator: true },
    { username: "Bluff_006", admin: true },
    { admin: true },
  ];
  eq(staffNames(participants, win).join(","), "Bluff_006,mod_person,quiet_staff,Cactus_Cat",
    "admin, moderator and Roblox_Staff participants, then the window's staff posters; `system`, flair groups, duplicates and nameless entries dropped");
  eq(staffNames(undefined, win).join(","), "Cactus_Cat", "no participants on the payload: the window's staff still name someone to ask for");
  eq(staffNames("not a list", []).length, 0, "a participants field of the wrong shape is nobody");
}

console.log("── projectIds ────────────────────────────────────────────────────");
{
  const stream = [101, 102, 103, 104, 105, 106, 107, 108];
  const out = projectIds([101, 104, 107, 999], stream, new Set([101]), "Bluff_006");
  eq([...out.keys()].join(","), "104,107", "ids in the filtered stream, minus the skipped and the unknown");
  eq(out.get(104)?.pos, 4, "position is 1-based: the fourth id of the stream is post 4 of 8");
  eq(out.get(107)?.pos, 7, "…and the seventh is 7");
  eq(out.get(104)?.who, "Bluff_006", "the name the caller decided on");
  eq(projectIds([], stream, new Set(), "").size, 0, "nothing filtered, nothing projected");
  eq(projectIds([103], [], new Set(), "").size, 0, "no stream to place against: nothing, never a guess");
}

console.log("── fromPayload ───────────────────────────────────────────────────");
{
  const post = (extra: Partial<TopicPost> & { id: number; post_number: number }): TopicPost => ({
    reply_to_post_number: null,
    ...extra,
  });
  const payload = {
    id: 4301387,
    slug: "a-slug",
    posts_count: 83,
    accepted_answer: { post_number: 17, username: "ashenix_dev" },
    details: { participants: [{ username: "Bluff_006", admin: true }] },
    post_stream: {
      posts: [
        post({ id: 1, post_number: 1, username: "ArawDev" }),
        post({ id: 4, post_number: 4, username: "Cactus_Cat", primary_group_name: "Roblox_Staff" }),
        post({ id: 5, post_number: 5, username: "system", admin: true, moderator: true, post_type: 3 } as Partial<TopicPost>),
      ],
      stream: Array.from({ length: 85 }, (_, i) => i + 1),
    },
  } as unknown as TopicPayload;
  const facts = fromPayload(payload);
  eq(facts.slug, "a-slug", "the slug, read as optional");
  eq(facts.total, 85, "the total is the stream length — the counter's own total — over posts_count");
  eq(facts.solved, 17, "the solution's number");
  eq(facts.names.get(17), "ashenix_dev", "the solution is named from accepted_answer.username when the window lacks the post");
  eq(facts.names.get(4), "Cactus_Cat", "window posts named");
  eq([...facts.staff.keys()].join(","), "4", "the window's staff, with the system row refused");
  eq([...facts.ids].join(","), "1,4,5", "the window's database ids");
  eq(facts.partial, true, "three of eighty-five loaded: the filter can find more");
  eq(facts.filterNames.join(","), "Bluff_006,Cactus_Cat", "participants' staff and the window's, for the filter");
}
{
  const facts = fromPayload({
    id: 1,
    posts_count: 2,
    accepted_answer: { post_number: 2, username: "from_payload" },
    post_stream: {
      posts: [
        { id: 1, post_number: 1, reply_to_post_number: null, username: "op" },
        { id: 2, post_number: 2, reply_to_post_number: null, username: "from_window" },
      ],
    },
  });
  eq(facts.names.get(2), "from_window", "a window post's own username is not overwritten by the accepted_answer one");
  eq(facts.total, 2, "no stream: posts_count is the total");
  eq(facts.partial, false, "the window is the whole topic: no request to make");
  eq(facts.slug, null, "no slug, no guess");
  eq(facts.filterNames.length, 0, "nobody to filter for");
}

console.log("── tickTitle ─────────────────────────────────────────────────────");
eq(tickTitle({ n: 42, kinds: ["staff"], who: "Bluff_006" }), "#42 · Bluff_006 · staff", "staff");
eq(tickTitle({ n: 17, kinds: ["solved"], who: null }), "#17 · solution", "unnamed solution");
eq(tickTitle({ n: 17, kinds: ["solved", "staff"], who: "Bluff_006" }),
  "#17 · Bluff_006 · solution, staff", "every role named, strongest first");

console.log("── isStaffPost ───────────────────────────────────────────────────");
const post = (extra: object) => ({ id: 1, post_number: 1, reply_to_post_number: null, ...extra });
check(isStaffPost(post({ staff: true })), "staff flag");
check(isStaffPost(post({ admin: true })), "admin without staff");
check(isStaffPost(post({ moderator: true })), "moderator without staff");
check(isStaffPost(post({ primary_group_name: "Roblox_Staff" })), "primary group alone — measured live on a staff member with no staff flag");
check(!isStaffPost(post({ primary_group_name: "UI_Designers", trust_level: 4 })), "a flair group and TL4 are not staff");
check(!isStaffPost(post({})), "nothing set");
check(isStaffPost(post({ staff: true, post_type: 1 })), "a regular post (type 1) by staff");
check(
  !isStaffPost(post({ staff: true, admin: true, moderator: true, username: "system", post_type: 3 })),
  "the auto-close notice — `system` is seeded admin and moderator, and the row is a small action",
);
check(!isStaffPost(post({ staff: true, post_type: 3 })), "a moderator's own small action (closed, pinned) is a row, not a reply");
check(!isStaffPost(post({ staff: true, admin: true, username: "system" })), "`system` is refused whatever the type");
check(isStaffPost(post({ staff: true, post_type: 2 })), "a moderator action (type 2, close-with-message) renders as a post and stays staff");
check(isStaffPost(post({ primary_group_name: "Roblox_Staff", post_type: 4 })), "a whisper by staff is still a staff post");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
