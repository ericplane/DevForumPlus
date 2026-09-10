import {
  assetTypeLabel,
  describeGroup,
  describeUser,
  referenceFromHref,
} from "../../src/discourse/modules/asset-preview";
import { categoryColor } from "../../src/discourse/site-data";

/**
 * The parsing underneath the hover cards — every pure decision that turns a
 * pasted URL or a JSON body into a card, or into nothing.
 *
 * The failure that matters is the same one links.test.ts guards: a card that
 * confidently describes the WRONG thing. A `/groups/` id read as an asset
 * would fetch a thumbnail for an unrelated catalog item; a category colour
 * that is not a colour would be written into a style. Each of those is held
 * here to "nothing" rather than "something".
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

// ── Roblox hrefs ────────────────────────────────────────────────────────────
const ref = (href: string) => {
  const r = referenceFromHref(href);
  return r ? `${r.kind}:${r.id}` : null;
};

console.log("── roblox hrefs ───────────────────────────────────────────────────");
eq(ref("https://www.roblox.com/library/21070012/Dominus"), "asset:21070012", "library");
eq(ref("https://www.roblox.com/catalog/1818/Classic-Decal"), "asset:1818", "catalog");
eq(ref("https://roblox.com/asset/1818"), "asset:1818", "asset, no subdomain");
eq(ref("https://create.roblox.com/store/asset/1818"), "asset:1818", "creator store");
eq(ref("https://create.roblox.com/marketplace/asset/1818/x"), "asset:1818", "old store spelling");
eq(ref("https://www.roblox.com/games/2753915549/Blox-Fruits"), "game:2753915549", "place");
eq(ref("https://www.roblox.com/groups/1234567/Studio-Name"), "group:1234567", "group");
eq(ref("https://www.roblox.com/communities/1234567/Studio-Name"), "group:1234567",
  "community — the current spelling, same namespace");
eq(ref("https://www.roblox.com/communities/1234567"), "group:1234567", "community, bare");
/* The 4-digit floor is for prose, where `rbxassetid://1` is a placeholder; a
 * `users/` segment has already said what its digits are, and the accounts
 * below 1000 are the staff and legacy ones posts actually link. */
eq(ref("https://www.roblox.com/users/156/profile"), "user:156", "builderman: 3 digits, carded");
eq(ref("https://www.roblox.com/users/1"), "user:1", "the Roblox account, 1 digit");
eq(ref("https://www.roblox.com/groups/7/Roblox"), "group:7", "a 1-digit group");
eq(ref("https://www.roblox.com/users/1234567/profile"), "user:1234567", "profile");
eq(ref("https://www.roblox.com/users/1234567"), "user:1234567", "profile, bare");
eq(ref("https://www.roblox.com/users/1234567/inventory"), "user:1234567", "profile, other tab");
eq(ref("HTTPS://WWW.ROBLOX.COM/USERS/1234567/PROFILE"), "user:1234567", "case-insensitive");
eq(ref("https://www.roblox.com/users/friends"), null, "no digits, no card");
eq(ref("https://www.roblox.com/groups/configure?id=1234567"), null, "the configure page");
eq(ref("https://www.roblox.com/library/123"), null, "asset below the 4-digit floor");
eq(ref("https://notroblox.com/library/1234567"), null, "wrong host");
eq(ref("https://www.roblox.com/develop"), null, "not a thing this cards");

// ── Asset kinds ─────────────────────────────────────────────────────────────
console.log("\n── asset kinds ────────────────────────────────────────────────────");
eq(assetTypeLabel(3), "Audio", "the commonest Scripting Support id");
eq(assetTypeLabel(13), "Decal", "decal");
eq(assetTypeLabel(1), "Image", "image");
eq(assetTypeLabel(4), "Mesh", "mesh");
eq(assetTypeLabel(40), "MeshPart", "meshpart");
eq(assetTypeLabel(10), "Model", "model");
eq(assetTypeLabel(38), "Plugin", "plugin");
eq(assetTypeLabel(24), "Animation", "animation");
eq(assetTypeLabel(53), "Animation", "a run cycle is still an animation");
eq(assetTypeLabel(61), "Video", "video");
eq(assetTypeLabel(9), "Place", "place");
eq(assetTypeLabel(5), "Script", "script");
eq(assetTypeLabel(41), "Accessory", "accessory families collapse");
eq(assetTypeLabel(999), null, "unknown id: no chip, no guess");
eq(assetTypeLabel("3"), null, "a string is not an id");
eq(assetTypeLabel(undefined), null, "missing");

// ── Group and user bodies ───────────────────────────────────────────────────
console.log("\n── group details ──────────────────────────────────────────────────");
{
  const g = describeGroup({
    id: 1234567,
    name: "Eurotunnel | Le Shuttle",
    memberCount: 12345,
    hasVerifiedBadge: true,
    owner: { userId: 1, username: "someone", displayName: "Someone" },
  });
  eq(g?.title, "Eurotunnel | Le Shuttle", "name");
  eq(g?.by, "by Someone", "owner, display name preferred");
  eq(g?.meta, "12.3K members", "member count, compacted");
  eq(g?.verified, true, "verified");
}
{
  const g = describeGroup({ name: "Solo", memberCount: 1, owner: null });
  eq(g?.by, null, "no owner line without an owner");
  eq(g?.meta, "1 member", "singular");
  eq(g?.verified, false, "not verified when the flag is absent");
}
eq(describeGroup({ name: "G", owner: { username: "handle", displayName: "" } })?.by, "by handle",
  "a blank display name falls through to the handle");
eq(describeGroup({ memberCount: 5 }), null, "no name, no card");
eq(describeGroup(null), null, "no body, no card");
eq(describeGroup({ name: "   " }), null, "a blank name is no name");

console.log("\n── user details ───────────────────────────────────────────────────");
{
  const u = describeUser({
    name: "builderman",
    displayName: "Builderman",
    created: "2006-02-27T21:06:40.3Z",
    hasVerifiedBadge: true,
  });
  eq(u?.title, "Builderman", "display name");
  eq(u?.by, "@builderman", "handle");
  eq(u?.meta, "joined 2006", "join year");
  eq(u?.verified, true, "verified");
}
{
  const u = describeUser({ name: "plainname", displayName: "", created: "not a date" });
  eq(u?.title, "plainname", "the handle stands in for an empty display name");
  eq(u?.by, "@plainname", "…and is still shown as the handle");
  eq(u?.meta, null, "a bad date is no date");
}
eq(describeUser({ displayName: "Ghost" }), null, "no handle, no card");
eq(describeUser(undefined), null, "no body, no card");

// ── Category colours ────────────────────────────────────────────────────────
console.log("\n── category colours ───────────────────────────────────────────────");
eq(categoryColor("0E76A8"), "#0e76a8", "six hex digits, as Discourse stores them");
eq(categoryColor("ffffff"), "#ffffff", "lower case in");
eq(categoryColor("#0E76A8"), null, "a hash on the way in is not the stored shape");
eq(categoryColor("0E76A"), null, "five digits");
eq(categoryColor("red"), null, "a keyword never reaches a style");
eq(categoryColor("0E76A8; background: url(x)"), null, "nothing but the digits");
eq(categoryColor(undefined), null, "missing");
eq(categoryColor(0x0e76a8), null, "a number is not the stored shape");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
