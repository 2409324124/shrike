import { useEffect } from "react";
import { create } from "zustand";
import type { McpAddRequest, McpHubState, ShrikeEvents, Skill } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { useDock } from "../dock/store.ts";

// MCP: the tools hub in the renderer. Main pushes "mcp:update" (health checks land there) and "mcp:unlocked" (MCP8).

type Unlocked = ShrikeEvents["mcp:unlocked"];
export interface Wanted {
  skill: Skill;
  missing: string[];
  run(): void; // run it anyway
}

interface McpStore {
  state: McpHubState | null;
  checkedAt: number; // the last "check all", so opening the tab twice doesn't start every server twice
  adding: string | null; // a catalog id whose form is open
  wanted: Wanted | null; // MCP7: a skill needs a server you don't have
  unlocked: Unlocked[];
  load(): Promise<void>;
  checkAll(force?: boolean): Promise<void>;
  act(fn: (a: ReturnType<typeof api>) => Promise<McpHubState>, what: string): Promise<boolean>;
  add(req: McpAddRequest): Promise<boolean>;
}

const STALE_MS = 5 * 60_000;

export const useMcp = create<McpStore>((set, get) => ({
  state: null,
  checkedAt: 0,
  adding: null,
  wanted: null,
  unlocked: [],
  async load() {
    const s = await Promise.resolve().then(() => api().mcpState()).catch(() => null);
    if (s) set({ state: s });
  },
  async checkAll(force) {
    if (!force && Date.now() - get().checkedAt < STALE_MS) return;
    set({ checkedAt: Date.now() });
    const s = await call((a) => a.mcpCheck(), "Couldn't check your tools");
    if (s) set({ state: s });
  },
  async act(fn, what) {
    const s = await call(fn, what);
    if (s) set({ state: s });
    return !!s;
  },
  add: (req) => get().act((a) => a.mcpAdd(req), "Couldn't add it"),
}));

/** Opens the Tools tab of the right dock. */
export const openTools = (catalogId?: string): void => {
  useDock.getState().show("tools");
  if (catalogId) useMcp.setState({ adding: catalogId });
};

/** Names this project can hand the agent right now (on, trusted, nothing missing). */
export const readyNames = (s: McpHubState | null): string[] => (s?.servers ?? []).filter((x) => x.enabled && x.trusted && !x.missing.length).map((x) => x.name);

/** MCP7: a skill that uses servers you don't have offers to add them first; true means go ahead and run. */
export async function skillReady(skill: Skill, run: () => void): Promise<boolean> {
  if (!skill.usesMcp?.length) return true;
  const st = useMcp.getState().state ?? (await api().mcpState().catch(() => null));
  if (st) useMcp.setState({ state: st });
  const have = new Set((st?.servers ?? []).filter((x) => readyNames(st).includes(x.name)).flatMap((x) => [x.name, x.catalogId ?? x.name]));
  const missing = skill.usesMcp.filter((n) => !have.has(n));
  if (!missing.length) return true;
  useMcp.setState({ wanted: { skill, missing, run }, adding: st?.catalog.some((c) => c.id === missing[0]) ? missing[0]! : null });
  useDock.getState().show("tools");
  return false;
}

/** Mount once (the Shell's tools layer): main's pushes keep every surface in step. */
export function useMcpBridge(): void {
  useEffect(() => {
    const a = api();
    void useMcp.getState().load();
    const offs = [
      a.on("mcp:update", (s) => s && Array.isArray(s.servers) && useMcp.setState({ state: s })),
      a.on("mcp:unlocked", (u) => u && typeof u.server === "string" && useMcp.setState((st) => ({ unlocked: [...st.unlocked, u].slice(-4) }))),
      a.on("project:opened", () => void useMcp.getState().load()),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
