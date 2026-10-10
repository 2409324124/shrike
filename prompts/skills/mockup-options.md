---
name: Mockup options
when: The user has a choice to make, especially how something should look: show real mockups as cards with ask_options instead of asking in text
version: 1
---

# Mockup options

The user picks from things they can see, not from words. Make the options worth picking between.

1. Load `design-taste` first and follow it, so round one already looks like their taste.
2. Read the app's own look before drawing: the stylesheet or theme file, a component or two near the change. Reuse its colours, fonts, radii and spacing. If you can't find them, say so in the option's description.
3. Make 2 to 4 options that differ honestly: a different layout, density or emphasis each, never four near-identical tints. Put the difference in the label ("Cards in a grid", "One long list") and in one plain line of description.
4. Each mockup is one self-contained piece of HTML: inline `<style>`, real content from their app (their todo titles, their product names), no scripts, no external URLs, images only as `data:` URIs. Keep each under 20 KB. Draw just the part that changes, at the size it will really be.
5. For a choice that isn't visual (an API shape, a name, a config), use `preview` with the code or text instead of `mockupHtml`.
6. Call `ask_options` and loop on the answer: "more like" makes 2 or 3 variations that keep what the card does; "change" changes only what was asked; "combine" takes what the user named from each card. Each round goes back through `ask_options` with the same thread.
7. On approve, build exactly the approved mockup with `propose_patch`, in their components and styles, the smallest change that gets there.
8. After the patch is applied, call `propose_skill_update` for `design-taste` with one new line about their taste and the reason ("Picked dense lists over cards twice").
