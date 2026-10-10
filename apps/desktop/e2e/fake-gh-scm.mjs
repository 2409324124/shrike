// A stand-in `gh` for SHRIKE_GH_BIN in the source control e2e: no pull request, every call logged, every write refused.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${args.join(" ")}\n`);
const [a, b] = args;
if (a === "--version") console.log("gh version 0.0.0 (fake)");
else if (a === "auth" && b === "status") console.log("Logged in (fake)");
else if (a === "pr" && b === "view") (console.error("no pull requests found for branch"), process.exit(1));
else if ((a === "pr" && (b === "list" || b === "checks")) || (a === "run" && b === "list")) console.log("[]");
else (console.error(`fake gh: ${args.join(" ")} is not faked`), process.exit(1));
