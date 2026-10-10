import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { plannerPath, runEval } from "./eval.ts";

// The voice gates (docs/16 §3). Grammar gates always; planner gates when its model is in userData/models
// (SHRIKE_EVAL_PLANNER=0 skips it); recording gates once WAVs are in fixtures/voice/recordings/.
//   node --test fixtures/voice/eval.test.ts

const planner = process.env.SHRIKE_EVAL_PLANNER !== "0" && existsSync(plannerPath());

test("voice gates", { timeout: 300_000 }, async () => {
  const r = await runEval({ planner });
  console.log(r.text);
  const failed = r.gates.filter((g) => g.pass === false);
  assert.deepEqual(failed.map((g) => `${g.gate}: ${g.measured}`), []);
  if (planner) assert.ok(r.gates.filter((g) => g.gate.startsWith("Phase 2")).every((g) => g.pass === true), "planner gates ran");
});
