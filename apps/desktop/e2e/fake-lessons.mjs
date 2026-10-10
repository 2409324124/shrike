// The lessons brain for e2e (fake-claude.mjs hands it the one-shot read-only prompts of main/review-lessons.ts).
// Clusters by keyword; a lesson that gets a newer comment gets new fix steps; the self-check finds a save button without a spinner.

export function answer(goal) {
  if (/^Check this change/.test(goal)) {
    const n = [...goal.matchAll(/^\[L(\d+)\] (.*)$/gm)];
    return n.map(([, i, t]) => (/loading state/i.test(t) && /<button(?![^>]*disabled)/.test(goal) ? `FOUND L${i}: src/components/forms/settings/SaveButton.tsx:3 the save button has no spinner while it saves and can be clicked twice` : `CLEAN L${i}`)).join("\n");
  }
  const lines = [...goal.matchAll(/^\[(c\d+)\]( LEARN)? #\d+ \S+ @\S+ \S+ [^:]*(?::\d+)?: (.*)$/gm)];
  const has = (id) => goal.includes(`- id: ${id} `);
  const pick = (re) => lines.filter((m) => re.test(m[3])).map((m) => m[1]);
  const loading = pick(/loading state|spinner/i);
  const lessons = [
    { id: "missing-loading-state", title: "Missing loading state", spot: "A button or list that fetches with nothing on screen while it waits", fix: has("missing-loading-state") && loading.length ? ["Disable the control and show a spinner from the click until the answer comes back", "Add a test that clicks twice and expects one request"] : ["Show a spinner while it loads, and disable the button that started it"], comments: loading },
    { id: "unvalidated-input", title: "Unvalidated input", spot: "A request body used before a schema check", fix: ["Parse the body with zod at the top of the handler", "Answer 400 with what was wrong"], comments: pick(/validat/i) },
    { id: "clear-names", title: "Clear names", spot: "Names like loading2 or data2", fix: ["Name booleans isX or hasX", "Say what it holds, not its type"], comments: lines.filter((m) => m[2] && !/loading state|validat/i.test(m[3])).map((m) => m[1]) },
  ].filter((l) => l.comments.length || has(l.id));
  const reviewers = [
    { login: "ana", style: ["Numbers findings W01 (blocks) and N01 (nit) with a severity dot", "Wants a pending state on anything that waits"], habit: "Blocks on missing states, nits on naming" },
    { login: "bo", style: ["Asks a question instead of saying what to change"], habit: "Questions about input and errors" },
  ];
  return `Grouped them.\n\`\`\`json\n${JSON.stringify({ lessons, reviewers })}\n\`\`\``;
}
