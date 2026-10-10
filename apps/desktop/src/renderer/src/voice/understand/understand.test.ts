import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT, type LiveContext } from "../../actions/registry.ts";
import { hkey, normalize, translit } from "./normalize.ts";
import { agentText, clauseCount, nearest, parse, stepTitle, type Step } from "./parse.ts";
import { nameScore, snapAll } from "./snap.ts";
import { checkPlan, plannerSchema, PLANNER_PREFIX } from "./plan.ts";
import { understand } from "./index.ts";

const CTX: LiveContext = {
  ...EMPTY_CONTEXT,
  prs: [{ number: 42, title: "Fix checkout total" }, { number: 57, title: "Add dark mode" }, { number: 61, title: "Bump deps" }],
  checks: [{ name: "lint", state: "pass" }, { name: "unit tests", state: "pass" }, { name: "e2e (chromium)", state: "fail" }],
  workspaces: [{ name: "shop" }, { name: "admin" }, { name: "docs" }],
  files: ["server/todos.controller.ts", "src/components/Checkout.tsx", "src/lib/cart.ts", "package.json", "README.md"],
  chains: ["polish-until-8"],
};
const plan = (t: string, ctx = CTX): Step[] | null => {
  const p = parse(t, ctx);
  return p.kind === "plan" ? p.steps : null;
};
const ids = (t: string): string => plan(t)?.map((s) => s.action + (Object.keys(s.slots).length ? `:${Object.values(s.slots).join(",")}` : "")).join(" > ") ?? "none";

test("tier 0: Devanagari to Roman with schwa deletion, never wiped", () => {
  assert.equal(translit("पुश करो"), "push karo");
  assert.equal(translit("अगला"), "aglaa");
  assert.equal(translit("गलती"), "galtee");
  assert.equal(translit("कमिट"), "kamit");
  assert.equal(translit("कदम"), "kadam");
  assert.deepEqual(normalize("लॉग्स दिखाओ").words, ["logs", "show"]);
  assert.ok(normalize("एडमिन वर्कस्पेस पे जाओ").words.includes("workspace"));
  assert.equal(normalize("ｓｈｏｗ ｌｏｇｓ").words.join(" "), "show logs", "NFKC");
});

test("tier 0: numbers in English, Hindi and other languages", () => {
  const n = (t: string) => normalize(t).words.join(" ");
  assert.equal(n("open PR forty two"), "open pr 42");
  assert.equal(n("PR bayalis kholo"), "pr 42 open");
  assert.equal(n("पीआर सत्तावन खोलो"), "pr 57 open");
  assert.equal(n("pull request number 61"), "pr 61");
  assert.equal(n("abre el pull request cuarenta y dos"), "open pr 42");
  assert.equal(n("öffne Pullrequest zwei und vierzig"), "open pr 42");
  assert.equal(n("PR #7"), "pr 7");
  assert.equal(n("push kar do"), "push do", "'do' stays a word unless a PR number is expected");
});

test("tier 0: Hinglish lexicon and the phonetic key", () => {
  assert.equal(hkey("dikhaao"), hkey("dikhao"));
  assert.equal(hkey("kholiye"), hkey("kholiye"));
  assert.deepEqual(normalize("zara logs dikhao na").words, ["logs", "show"]);
  assert.deepEqual(normalize("app band karo").words, ["app", "stop"]);
  assert.deepEqual(normalize("sab kuch commit karke push kar do").words, ["all", "commit", "then", "push", "do"]);
});

test("tier 1: everyday phrasings land on the right action", () => {
  const cases: [string, string][] = [
    ["Next.", "step.next"], ["next step please", "step.next"], ["Previous", "step.prev"], ["step back", "step.prev"], ["next trip", "trip.next"], ["Previous trip.", "trip.prev"],
    ["Dive in?", "dive"], ["zoom in", "dive"], ["go back", "escape"], ["Close.", "escape"], ["never mind", "escape"],
    ["Show logs.", "panel.show:logs"], ["show me the logs", "panel.show:logs"], ["open the console", "panel.show:logs"], ["logs", "panel.show:logs"], ["network tab", "panel.show:network"],
    ["open the API explorer", "panel.show:api"], ["show terminal", "panel.show:terminal"], ["time view", "panel.show:time"], ["show the timeline", "panel.show:time"], ["hide the logs", "panel.hide:logs"],
    ["Where did it break?", "failure.next"], ["what broke", "failure.next"], ["replay", "replay"], ["play it again", "replay"], ["record a clip", "record"], ["start recording", "record"],
    ["show the code", "file.open_focused"], ["skills", "panel.show:skills"], ["show flows", "panel.show:flows"], ["point mode", "point"], ["quick open", "quick_open"],
    ["run the app", "app.run"], ["stop the server", "app.stop"], ["kill the server", "app.stop"], ["restart", "app.restart"], ["stop the agent", "agent.stop"], ["fix it", "agent.fix"], ["try both", "race.try_both"],
    ["ship it", "pr.create"], ["explain this", "agent.explain"], ["what changed", "compare"], ["write it up", "issue"], ["run the tests", "tests.run"], ["ask", "agent.open"],
    ["push", "git.push"], ["pull", "git.pull"], ["commit my changes", "git.commit"], ["discard my changes", "git.discard"], ["yes", "confirm.yes"], ["haan", "confirm.yes"], ["हाँ जी", "confirm.yes"], ["nahi", "confirm.no"], ["नहीं जी", "confirm.no"], ["wapas karo", "plan.undo"], ["phir se", "plan.repeat"],
  ];
  for (const [t, want] of cases) assert.equal(ids(t), want, t);
});

test("tier 1: slots snap to live lists; values not live never parse", () => {
  assert.equal(ids("open PR 42"), "pr.open:42");
  assert.equal(ids("PR 57 dikhao"), "pr.open:57");
  assert.equal(ids("open PR 99"), "none", "not an open PR");
  assert.equal(ids("open the failing check"), "ci.open_check:e2e (chromium)");
  assert.equal(ids("open the failing check on PR 42"), "ci.open_check:e2e (chromium),42");
  assert.equal(ids("fix the lint check"), "ci.fix_check:lint");
  assert.equal(ids("switch to the admin workspace"), "workspace.switch:admin");
  assert.equal(ids("admin workspace pe jao"), "workspace.switch:admin");
  assert.equal(ids("go to the billing workspace"), "none", "no such workspace");
  assert.equal(ids("send a GET request to /api/todos"), "api.send:GET,/api/todos");
  assert.equal(ids("create a new workspace called billing"), "workspace.create:billing");
});

test("tier 1: file names only after a file verb", () => {
  assert.equal(ids("open cart.ts"), "file.open:src/lib/cart.ts");
  assert.equal(ids("open the todos controller"), "file.open:server/todos.controller.ts");
  assert.equal(ids("readme file kholo"), "file.open:README.md");
  assert.equal(ids("kill the server"), "app.stop", "not server/todos.controller.ts");
  assert.equal(ids("open the failing check"), "ci.open_check:e2e (chromium)", "not Checkout.tsx");
});

test("tier 1: clauses split on and / then / aur / phir / karke, in order", () => {
  assert.equal(ids("stage all files and push them"), "git.stage_all > git.push");
  assert.equal(ids("stage everything, commit, and push"), "git.stage_all > git.commit > git.push");
  assert.equal(ids("सारी फाइलें स्टेज करो और पुश करो"), "git.stage_all > git.push");
  assert.equal(ids("सब कुछ कमिट करके पुश कर दो"), "git.commit > git.push");
  assert.equal(ids("run the tests, then open the terminal"), "tests.run > panel.show:terminal");
  assert.equal(ids("restart the app and banana"), "none", "every clause must parse, or the grammar abstains");
  assert.equal(clauseCount("open the logs and then run the app"), 2);
});

test("tier 1: two live values too close to call become chips", () => {
  const two: LiveContext = { ...CTX, checks: [{ name: "e2e (chromium)", state: "fail" }, { name: "e2e (webkit)", state: "fail" }] };
  const p = parse("open the failing check", two);
  assert.equal(p.kind, "close");
  assert.deepEqual(p.kind === "close" && p.options.map((o) => o[0]!.slots.check), ["e2e (chromium)", "e2e (webkit)"]);
});

test("files: a word that is also a verb stays a name, and two equal files become chips", () => {
  const todo: LiveContext = { ...CTX, files: ["server/todos.controller.ts", "server/todos.list.ts", "src/TodoForm.tsx", "src/TodoList.tsx"] };
  const p = (t: string) => parse(t, todo);
  assert.deepEqual(p("open todo list"), { kind: "plan", steps: [{ action: "file.open", slots: { path: "src/TodoList.tsx" } }] });
  assert.equal(p("open the to do file").kind, "close", "ASR's \"to do\" is todo");
  const c = p("open the todo file");
  assert.deepEqual(c.kind === "close" && c.options.map((o) => o[0]!.slots.path), ["src/TodoForm.tsx", "src/TodoList.tsx"]);
});

test("the agent gets questions and 'ask Claude', never length", () => {
  assert.equal(agentText("ask Claude why the checkout total is wrong"), "why the checkout total is wrong");
  assert.equal(agentText("CI kyun fail hua Claude se pucho"), "ci kyun fail hua");
  assert.equal(agentText("why did checkout fail?"), "why did checkout fail");
  assert.equal(agentText("show me why CI is red"), null);
  assert.equal(ids("please could you open the terminal and then restart the app for me right now"), "panel.show:terminal > app.restart", "long is not a reason for the agent");
  assert.equal(ids("up next, write the tests"), "chain.queue:write the tests");
});

test("snapping: Jaro-Winkler, Hinglish key, margins", () => {
  assert.ok(nameScore("admn", "admin") >= 0.88);
  assert.ok(nameScore("e2e", "e2e (chromium)") > 0.9);
  assert.equal(nameScore("billing", "shop"), 0);
  assert.equal(snapAll(["dox"], [{ n: "docs" }, { n: "shop" }], (x) => [x.n])[0]?.value.n, "docs");
});

test("card copy and the nearest commands", () => {
  assert.equal(stepTitle({ action: "pr.open", slots: { pr: 42 } }), "Open PR 42");
  assert.equal(stepTitle({ action: "file.open", slots: { path: "src/lib/cart.ts" } }), "Open cart.ts");
  assert.ok(nearest("show the thing").length > 0);
  assert.deepEqual(nearest(""), []);
});

test("planner schema: every slot an enum of live values; actions with nothing live drop out", () => {
  const s = JSON.stringify(plannerSchema(CTX));
  assert.ok(s.includes('"enum":[42,57,61]'));
  assert.ok(s.includes('"e2e (chromium)"'));
  assert.ok(!s.includes('"const":"confirm.yes"'), "plan control words are not plannable");
  assert.ok(!JSON.stringify(plannerSchema(EMPTY_CONTEXT)).includes('"const":"pr.open"'), "no live PRs, no pr.open");
  assert.ok(PLANNER_PREFIX.includes("- pr.open(pr):"));
});

test("post-plan checks drop what nobody said", () => {
  const got = (text: string, p: unknown[]) => checkPlan({ plan: p }, text, CTX).steps.map((s) => s.action);
  assert.deepEqual(got("कंसोल दिखाओ", [{ a: "panel.show", panel: "logs" }, { a: "app.run" }]), ["panel.show"]);
  assert.deepEqual(got("open PR 42", [{ a: "pr.open", pr: "#42" }]), []);
  assert.deepEqual(got("open it", [{ a: "pr.open", pr: 99 }]), [], "not live");
  assert.deepEqual(got("सारी करो और कुछ कर दो", [{ a: "git.stage_all" }, { a: "git.commit" }, { a: "git.push" }]), ["git.stage_all"], "garbled: one step at most");
  assert.deepEqual(got("push it", [{ a: "confirm.yes" }, { a: "git.push" }]), ["git.push"]);
  assert.deepEqual(checkPlan("nonsense", "x", CTX).steps, []);
  assert.deepEqual(got("Fall the latest changes", [{ a: "git.discard" }]), [], "destructive needs its own verb");
  assert.deepEqual(got("send my work up to origin", [{ a: "git.push" }]), ["git.push"]);
  assert.deepEqual(got("what a lovely day", [{ a: "pr.merge" }]), [], "outward needs one of its words");
  assert.deepEqual(got("PR Forty two colo", [{ a: "pr.merge" }]), [], "\"PR\" alone is not a merge");
});

test("the cascade: grammar first, planner only when it abstains, misses never silent", async () => {
  let asked = 0;
  const fake = async () => (asked++, { json: { plan: [{ a: "panel.show", panel: "terminal" }] } });
  const g = await understand("show logs", CTX, fake);
  assert.equal(g.kind === "plan" && g.source, "grammar");
  assert.equal(asked, 0);
  const p = await understand("what did the server print", CTX, fake);
  assert.equal(p.kind === "plan" && p.source, "planner");
  const miss = await understand("what did the server print", CTX, async () => ({ error: "timeout" as const }));
  assert.equal(miss.kind === "none" && miss.why, "timeout");
  const none = await understand("open the logs and banana", CTX);
  assert.equal(none.kind, "none");
});

test("speed: tier 0 + 1 far under a millisecond", () => {
  const t = performance.now();
  for (let i = 0; i < 2000; i++) parse(i % 2 ? `could you please show me the network tab ${i}` : `सारी फाइलें स्टेज करो और पुश करो ${i}`, CTX);
  const per = (performance.now() - t) / 2000;
  assert.ok(per < 1, `${per.toFixed(3)}ms per parse`);
});
