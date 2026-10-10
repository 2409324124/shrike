// A stand-in `gh` for SHRIKE_GH_BIN in the workspaces e2e: nothing reaches GitHub.
// Lists one open PR (#5 from pull/5/head on the test's local origin), checks it out like gh does, and logs every call.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${args.join(" ")}\n`);
const [a, b] = args;
const PR = { number: 5, title: "Coupons take whole cents", headRefName: "coupon-fix", url: "https://github.com/acme/shop/pull/5", isDraft: false, author: { login: "sam" }, state: "OPEN" };

if (a === "--version") console.log("gh version 0.0.0 (fake)");
else if (a === "auth" && b === "status") console.log("Logged in (fake)");
else if (a === "pr" && b === "list") console.log(JSON.stringify([PR]));
else if (a === "pr" && b === "checkout" && args[2] === "5") {
  execFileSync("git", ["fetch", "-q", "origin", "pull/5/head:coupon-fix"], { stdio: "inherit" });
  execFileSync("git", ["checkout", "-q", "coupon-fix"], { stdio: "inherit" });
} else {
  console.error(`fake gh: ${args.join(" ")} is not faked`);
  process.exit(1);
}
