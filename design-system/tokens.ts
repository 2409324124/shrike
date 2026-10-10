// Shrike design tokens. Single source for the renderer (CSS variables) and the 3D scene (three.js colours).
// Catalogue and usage: design-system/README.md. Visual specimen: design-system/specimen.html

export const color = {
  // grounds
  void: "#02040A", // deepest background, space
  abyss: "#060B18", // panels behind glass, vignette edge
  navy: "#0A1633", // radial glow centre, blueprint ground
  // glass
  glass: "rgba(120,170,255,0.07)", // frosted pane fill
  glassStrong: "rgba(150,195,255,0.12)", // hovered / focused pane
  glassEdge: "rgba(180,215,255,0.28)", // pane border, bevel highlight
  hair: "rgba(160,205,255,0.14)", // hairlines, grid, brackets
  // ink
  ink: "#EAF2FF", // primary text
  inkDim: "#7D8CA8", // secondary text, dimmed code
  inkFaint: "#3A4763", // tertiary, disabled, far grid
  core: "#F6FBFF", // white-hot centre of glows and beams
  // signal spectrum (light)
  cyan: "#3FE7FF", // live line, comet head, primary glow
  blue: "#2F7BFF", // electric blue, wireframes, data
  violet: "#8B5CF6", // agent / AI, fiber origin
  magenta: "#C06BFF", // AI output fibers
  teal: "#2DD4BF", // inactive traces, secondary data
  amber: "#FF9A3C", // ACTIVE path trace (the route being travelled)
  // semantic (never used as decoration)
  ok: "#38F2A0",
  slow: "#FFC15C",
  fail: "#FF3B4E",
  failDeep: "#3A0710", // red alert ground
  shade: "#02040A", // drop shadows under cards and sheets (a soft grey-blue in light themes)
  well: "#000000", // recessed fills (code blocks, inputs): Tailwind's black/NN
  lift: "#FFFFFF", // faint hover and row tints: Tailwind's white/NN
  // brand (B-brand2 emblem gradient, top to bottom; the terminal banner)
} as const;

type Palette = Record<keyof typeof color, string>;
const gradients = (c: Palette) => ({
  spectrum: `linear-gradient(90deg, ${c.violet}, ${c.blue} 50%, ${c.cyan})`, // fibers, journey arc, underlines
  aiOut: `linear-gradient(90deg, ${c.blue}, ${c.magenta})`, // processing core → answers
  beam: `linear-gradient(180deg, transparent, ${c.blue} 35%, ${c.core} 80%)`, // light column
  radialGlow: `radial-gradient(ellipse at 50% 45%, ${c.navy} 0%, ${c.void} 70%)`, // stage background
  alert: `radial-gradient(ellipse at 50% 40%, color-mix(in srgb, ${c.fail} 22%, ${c.failDeep}) 0%, ${c.void} 75%)`, // red alert ground
});
export const gradient = gradients(color);

export const font = {
  display: `"Space Grotesk", "Inter", system-ui, sans-serif`, // headlines (700) and thin caps headings (300)
  ui: `"Space Grotesk", "Inter", system-ui, sans-serif`,
  mono: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`, // code, micro-labels, telemetry
} as const;

export const type = {
  hero: { size: 64, weight: 700, tracking: "-0.02em" }, // "AI + FIGMA" style bold headline
  heading: { size: 28, weight: 300, tracking: "0.04em", caps: true }, // "SHARE OF MODEL"
  subhead: { size: 12, weight: 500, tracking: "0.32em", caps: true }, // "MEASURE WHAT MATTERS", coloured
  caption: { size: 18, weight: 500, tracking: "0" }, // playback caption
  body: { size: 14, weight: 400, tracking: "0" },
  label: { size: 11, weight: 500, tracking: "0.16em", caps: true, mono: true }, // micro-labels, telemetry
  numeral: { size: 40, weight: 300, tracking: "-0.01em" }, // big thin metric numbers
  code: { size: 13, weight: 400, tracking: "0", mono: true, lineHeight: 1.55 },
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64 } as const;
export const radius = { chip: 6, control: 10, card: 14, pane: 16, pill: 999 } as const;

export const glow = {
  // CSS text/box glows; 3D uses bloom with these intensities
  soft: `0 0 12px rgba(63,231,255,0.35)`,
  strong: `0 0 24px rgba(63,231,255,0.55), 0 0 2px rgba(246,251,255,0.9)`,
  fail: `0 0 22px rgba(255,59,78,0.6)`,
  amber: `0 0 18px rgba(255,154,60,0.55)`,
  bloom: { intensity: 1.1, threshold: 0.62, smoothing: 0.2, radius: 0.7 },
} as const;

export const motion = {
  quick: 160, // ms, UI feedback
  base: 280, // panels, cards
  camera: 700, // camera flights (500–900)
  hop: 520, // comet hop between steps
  ease: "cubic-bezier(0.65, 0, 0.35, 1)", // in-out for camera and layout
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)", // things arriving
  particleSpeed: 0.35, // fiber particles, units/s
} as const;

export const scene = {
  fogNear: 18,
  fogFar: 70,
  gridSpacing: 2, // tunnel/floor grid cell, world units
  paneDepth: 0.06, // glass thickness for the bevel/edge highlight
  paneOpacity: 0.82,
  dimOpacity: 0.25, // inactive panes (ADHD: one thing glows)
  dofFocusRange: 6, // depth-of-field band around the focused pane
  fiberCount: 24, // strands per fiber bundle
} as const;

// Looks (sensor modes). Each maps the palette onto one mood; semantic colours stay meaningful in every look.
export const looks = {
  normal: { ground: color.void, primary: color.cyan, secondary: color.violet, trace: color.amber },
  thermal: { ground: "#05030A", primary: "#FFFFFF", secondary: "#FF6A00", trace: "#FFD000" }, // duration heat: blue→magenta→orange→white
  night: { ground: "#010A04", primary: "#7CFF8A", secondary: "#2BD45A", trace: "#B8FFB0" },
  blueprint: { ground: color.navy, primary: "#FFFFFF", secondary: color.blue, trace: "#9CC8FF" },
  alert: { ground: color.failDeep, primary: color.fail, secondary: "#FF7A85", trace: color.fail }, // red alert, only for failures
} as const;

// Discovered lanes (D9–D11) and the shapes drawn on them (T15–T17). Pixel values for the DOM Thread view.
export const lane = {
  sliver: 26, // D10: untouched lane width
  maxSameKind: 6, // D10: more touched lanes of one kind than this collapse into a group header
  pokeHeight: 8, // T15: out-and-back gap of a cache hit
  forkGap: 28, // T17: distance between two branches that run at the same time
  ghostDash: "4 6", // D11: expected-but-unseen lane line
  order: ["caller", "client", "service", "queue", "cache", "data", "outside"], // D9
} as const;

// docs/13: SDLC rail (L1–L7), CI dots (G4), worktree tabs (W1), skill source tags (S1/S2). Pixel values for the DOM.
export const sdlc = {
  stages: ["spot", "understand", "fix", "prove", "review", "ship", "watch"], // rail order, left to right
  dot: 7, // idle/done/failed stage dot; idle is a 1.5px inkFaint ring
  dotActive: 9, // the one current stage: filled cyan, 3px halo + glow.soft
  doneFill: "rgba(56,242,160,0.55)", // done stage dot and segment (segment at 0.35)
  ci: { pass: color.ok, fail: color.fail, pending: color.slow, skipped: color.inkFaint, size: 9 }, // G4 check dots
  worktreeDot: 6, // W1 tab status dot: ok, slow (running, pulsing), fail
  source: { project: color.cyan, builtin: color.violet, personal: color.ink, claude: color.amber }, // S1/S2 tag borders; claude = read-only import
  approval: "rgba(255,193,92,0.45)", // border of a plain-words approval box (push, merge, remove worktrees)
} as const;

// Place-kind glyphs (D1–D7) and agent marks, as SVG markup for a 12×12 viewBox, stroked with currentColor (1.3px, round).
export const placeGlyph = {
  browser: '<path d="M3 2l6 4.2-2.6.6L8 10l-1.3.6L5.2 7.4 3 9z"/>', // caller: a click
  terminal: '<path d="M2 3.5l3 2.5-3 2.5M6.5 9.5H10"/>', // caller: curl, Postman, scripts
  clock: '<circle cx="6" cy="6" r="4.2"/><path d="M6 3.6V6l1.8 1.2"/>', // caller: cron
  client: '<rect x="1.5" y="2.5" width="9" height="7" rx="1.2"/><path d="M1.5 4.6h9"/>',
  service: '<path d="M6 1.5l3.9 2.25v4.5L6 10.5 2.1 8.25v-4.5z"/>',
  queue: '<path d="M2 3.5h8M2 6h8M2 8.5h5"/>',
  cache: '<path d="M6.8 1.5L3 6.6h3l-.8 3.9L9 5.4H6z"/>',
  data: '<ellipse cx="6" cy="3" rx="3.8" ry="1.4"/><path d="M2.2 3v6c0 .8 1.7 1.4 3.8 1.4s3.8-.6 3.8-1.4V3M2.2 6c0 .8 1.7 1.4 3.8 1.4S9.8 6.8 9.8 6"/>',
  outside: '<path d="M5 2.5H2.5v7h7V7M7 2h3v3M10 2L5.5 6.5"/>',
  eye: '<path d="M1 6s1.8-3.5 5-3.5S11 6 11 6s-1.8 3.5-5 3.5S1 6 1 6z"/><circle cx="6" cy="6" r="1.5"/>', // A11 watched-by, A9 watcher
  pin: '<path d="M6 11V7.4M3.6 1.8h4.8l-.7 3 1.4 2.4H2.9l1.4-2.4z"/>', // A5 memory
} as const;

// MCP: tool-server glyphs (MCP2 cards, MCP6 X-ray chips) for a 12x12 viewBox, stroked with currentColor; keys match mcp-catalog.json "glyph".
export const mcpGlyph = {
  browser: placeGlyph.client,
  git: '<circle cx="3.5" cy="2.8" r="1.3"/><circle cx="3.5" cy="9.2" r="1.3"/><circle cx="8.5" cy="4.8" r="1.3"/><path d="M3.5 4.1v3.8M8.5 6.1c0 1.6-2.2 1.8-4.2 2.3"/>',
  data: placeGlyph.data,
  files: '<path d="M3 1.5h4l2.5 2.5v6.5H3zM7 1.5V4h2.5"/>',
  fetch: '<path d="M6 1.5v6.2M3.6 5.4L6 7.8l2.4-2.4M2 10.4h8"/>',
  issue: '<circle cx="6" cy="6" r="4.2"/><path d="M6 3.6v2.8M6 8.3v.1"/>',
  design: '<path d="M2 10l.9-2.9 5.6-5.6 2 2L4.9 9.1zM7.4 2.6l2 2"/>',
  pay: '<rect x="1.5" y="3" width="9" height="6" rx="1"/><path d="M1.5 5h9M3.4 7.4h2"/>',
  docs: '<path d="M1.8 2.6h3.3c.5 0 .9.4.9.9v6.9c0-.5-.4-.8-.9-.8H1.8zM10.2 2.6H6.9c-.5 0-.9.4-.9.9v6.9c0-.5.4-.8.9-.8h3.3z"/>',
  memory: '<path d="M3.5 1.5h5v9L6 8.6l-2.5 1.9z"/>',
  plug: '<path d="M4.2 1.5V4M7.8 1.5V4M2.8 4h6.4v1.6a3.2 3.2 0 0 1-6.4 0zM6 8.8v1.7"/>',
} as const;
// Colour names (keys of `color`), so the DOM can use cssColor and follow the theme.
export const mcp = {
  tone: "teal", // MCP6: a call to one of the user's own servers (Shrike's own tools stay violet)
  dot: 7, // MCP2 status dot: ok, fail, slow pulsing while checking, inkFaint not checked or off
  source: { "claude-user": "amber", "claude-project": "amber", "claude-local": "amber", "shrike-personal": "ink", "shrike-project": "cyan" }, // MCP2 source tag borders, like S1/S2
} as const satisfies { tone: keyof typeof color; dot: number; source: Record<string, keyof typeof color> };

// Syntax colours for code (file view, dive card, panes). Abyss values; themes override them below.
export const code = {
  bg: "#04060A",
  fg: "#B9C7DA",
  comment: "#4A586C",
  keyword: "#7E9CFF",
  punct: "#6F7F96",
  string: "#9EE6B4",
  number: "#F5A97F",
  fn: "#F2E2B8",
  type: "#7FE0E8",
  param: "#D7C4FF",
  prop: "#C9D6E8",
  tag: "#6CD4FF",
  attr: "#B7A8FF",
  self: "#E8B9FF",
} as const;

// Themes (Z1–Z6 in README.md): each overrides only what differs from Abyss. Semantic colours keep their meaning in every theme.
export type ThemeId = "abyss" | "void" | "tokyo" | "mocha" | "daylight" | "contrast";
export interface Theme {
  label: string;
  blurb: string; // one plain line for the picker
  scheme: "dark" | "light";
  glow: boolean; // false: no text or box glows (high contrast)
  color: Partial<Palette>;
  code: Partial<Record<keyof typeof code, string>>;
}

export const themes: Record<ThemeId, Theme> = {
  abyss: { label: "Abyss", blurb: "Deep navy space lit by your app. The original.", scheme: "dark", glow: true, color: {}, code: {} },
  void: {
    label: "Void",
    blurb: "Pure black for OLED screens and late nights.",
    scheme: "dark",
    glow: true,
    color: { void: "#000000", abyss: "#05070C", navy: "#070B16", glass: "rgba(120,170,255,0.05)", hair: "rgba(160,205,255,0.12)", inkDim: "#8391AC", shade: "#000000" },
    code: { bg: "#000000" },
  },
  tokyo: {
    label: "Tokyo",
    blurb: "Indigo city lights, after Tokyo Night.",
    scheme: "dark",
    glow: true,
    color: {
      void: "#16161E", abyss: "#1A1B26", navy: "#24283B",
      glass: "rgba(122,162,247,0.07)", glassStrong: "rgba(122,162,247,0.13)", glassEdge: "rgba(169,177,214,0.28)", hair: "rgba(169,177,214,0.14)",
      ink: "#C0CAF5", inkDim: "#8189B5", inkFaint: "#4E5579", core: "#F0F4FF",
      cyan: "#7DCFFF", blue: "#7AA2F7", violet: "#A98AE6", magenta: "#BB9AF7", teal: "#73DACA", amber: "#FF9E64",
      ok: "#9ECE6A", slow: "#E0AF68", fail: "#F7768E", failDeep: "#2D1520", shade: "#0B0B10",
    },
    code: { bg: "#16161E", fg: "#A9B1D6", comment: "#5F6996", keyword: "#BB9AF7", punct: "#89DDFF", string: "#9ECE6A", number: "#FF9E64", fn: "#7AA2F7", type: "#2AC3DE", param: "#E0AF68", prop: "#73DACA", tag: "#F7768E", attr: "#BB9AF7", self: "#F7768E" },
  },
  mocha: {
    label: "Mocha",
    blurb: "Warm pastels on soft dark, after Catppuccin Mocha.",
    scheme: "dark",
    glow: true,
    color: {
      void: "#1E1E2E", abyss: "#181825", navy: "#313244",
      glass: "rgba(205,214,244,0.06)", glassStrong: "rgba(205,214,244,0.11)", glassEdge: "rgba(186,194,222,0.30)", hair: "rgba(186,194,222,0.15)",
      ink: "#CDD6F4", inkDim: "#A6ADC8", inkFaint: "#6C7086", core: "#F5E0DC",
      cyan: "#89DCEB", blue: "#89B4FA", violet: "#CBA6F7", magenta: "#F5C2E7", teal: "#94E2D5", amber: "#FAB387",
      ok: "#A6E3A1", slow: "#F9E2AF", fail: "#F38BA8", failDeep: "#3B1F2B", shade: "#11111B",
    },
    code: { bg: "#1E1E2E", fg: "#CDD6F4", comment: "#7F849C", keyword: "#CBA6F7", punct: "#9399B2", string: "#A6E3A1", number: "#FAB387", fn: "#89B4FA", type: "#F9E2AF", param: "#EBA0AC", prop: "#B4BEFE", tag: "#89B4FA", attr: "#F9E2AF", self: "#F38BA8" },
  },
  daylight: {
    label: "Daylight",
    blurb: "Ink on paper for bright rooms. Glows turn into soft shadows.",
    scheme: "light",
    glow: true,
    color: {
      void: "#F6F4EF", abyss: "#FFFFFF", navy: "#E4EAF6",
      glass: "rgba(40,70,140,0.05)", glassStrong: "rgba(40,70,140,0.09)", glassEdge: "rgba(30,50,100,0.32)", hair: "rgba(30,50,100,0.16)",
      ink: "#161B26", inkDim: "#4B5466", inkFaint: "#8A92A3", core: "#0B1020",
      cyan: "#0B7299", blue: "#1F5FD6", violet: "#6D3FD6", magenta: "#9B2FA0", teal: "#0F7A6E", amber: "#A84E08",
      ok: "#137A42", slow: "#8A5A00", fail: "#C8202F", failDeep: "#FBE3E5", shade: "rgba(22,30,52,0.20)", well: "#6B5E45", lift: "#1E2A4A",
     
    },
    code: { bg: "#FFFFFF", fg: "#24292F", comment: "#6E7781", keyword: "#8250DF", punct: "#57606A", string: "#116329", number: "#953800", fn: "#0550AE", type: "#0A6A74", param: "#953800", prop: "#1F4F99", tag: "#116329", attr: "#6639BA", self: "#CF222E" },
  },
  contrast: {
    label: "High contrast",
    blurb: "Maximum legibility. Solid edges, no soft glows.",
    scheme: "dark",
    glow: false,
    color: {
      void: "#000000", abyss: "#000000", navy: "#000000",
      glass: "rgba(255,255,255,0.08)", glassStrong: "rgba(255,255,255,0.16)", glassEdge: "#FFFFFF", hair: "rgba(255,255,255,0.55)",
      ink: "#FFFFFF", inkDim: "#E6E6E6", inkFaint: "#B3B3B3", core: "#FFFFFF",
      cyan: "#3FF5FF", blue: "#8FBBFF", violet: "#CDB0FF", magenta: "#F0A8FF", teal: "#4DF0D8", amber: "#FFB066",
      ok: "#5CFFA8", slow: "#FFD666", fail: "#FF7A86", failDeep: "#3A0008", shade: "#000000",
    },
    code: { bg: "#000000", fg: "#FFFFFF", comment: "#C0C8D4", keyword: "#CDB0FF", punct: "#E0E0E0", string: "#8CFFB0", number: "#FFC08A", fn: "#FFE9A8", type: "#7FF0FF", param: "#E6D2FF", prop: "#FFFFFF", tag: "#7FD6FF", attr: "#D9C8FF", self: "#F2C2FF" },
  },
};

export const THEME_IDS = Object.keys(themes) as ThemeId[];

/** The full palette and code colours of a theme. */
export function palette(id: ThemeId = "abyss"): { color: Palette; code: Record<keyof typeof code, string> } {
  const t = themes[id] ?? themes.abyss;
  return { color: { ...color, ...t.color }, code: { ...code, ...t.code } };
}

/** `color`'s keys as CSS variable references, for DOM styles that must follow the theme. Canvas and exports keep `color`. */
export const cssColor = Object.fromEntries(Object.keys(color).map((k) => [k, `var(--c-${kebab(k)})`])) as Palette;

/** CSS custom properties for :root, generated from the tokens above for one theme. */
export function cssVariables(theme: ThemeId = "abyss"): string {
  const { color: c, code: k } = palette(theme);
  const lines: string[] = [];
  for (const [n, v] of Object.entries(c)) lines.push(`--c-${kebab(n)}: ${v};`);
  for (const [n, v] of Object.entries(k)) lines.push(`--code-${n}: ${v};`);
  for (const [n, v] of Object.entries(gradients(c))) lines.push(`--g-${kebab(n)}: ${v};`);
  for (const [k, v] of Object.entries(font)) lines.push(`--f-${k}: ${v};`);
  for (const [k, v] of Object.entries(radius)) lines.push(`--r-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(space)) lines.push(`--s-${k}: ${v}px;`);
  lines.push(`--ease: ${motion.ease};`, `--ease-out: ${motion.easeOut};`, `color-scheme: ${themes[theme]?.scheme ?? "dark"};`);
  return `:root{${lines.join("")}}`;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
