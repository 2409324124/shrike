---
name: Plan a feature
when: The user wants to build something new ("Plan this: …", or a GitHub issue): turn the idea into a quest with objectives, each proven by a flow
scope: project
version: 1
---

# Plan a feature

A quest is the user's idea split into a few objectives they can see working. Each objective is checked off by Shrike, not by you: only when its flow (a recorded journey through the app) passes. Plan here; build later, one objective at a time.

1. Call `list_quests`. Find the quest named in the ask (its id) and the saved flows you could reuse.
2. Read just enough code to know where the feature lives: `list_files`, then `read_file` on the screen and the route it touches.
3. Ask before you plan. Call `ask_options` with 2 or 3 scopes as cards ("Just the basics", "With the extras", "The whole thing"), each a `preview` that lists what's in and what's out in plain words. When a part is visual, load `mockup-options` and `design-taste` first and give those cards real mockups.
4. Call `propose_quest` with the scope the user approved: a short title and 2 to 5 objectives. Each objective is one plain sentence a non-coder understands ("Click a todo's title to edit it"), and its `doneWhen` is something a user can click through and see ("Editing a todo keeps the new title"). No file names, no jargon. It waits for the user; if they say no, ask what to change and propose again.
5. Give every objective a flow with `link_flow`: a saved flow by name when one already proves it, otherwise new `steps` (click, type, navigate by the visible names in the app). A flow for something that isn't built yet will fail for now; that's expected, it turns green once it works.
6. Stop there unless the user asked you to build too. End with one line: the quest, its objectives, and which one to start with.
7. If you learned how this project's features are best planned (what scope it likes, which flows to reuse), call `propose_skill_update` for `plan-feature`. Shrike keeps it once every objective's flow passes.
