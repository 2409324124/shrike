import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

// Use Shrike from your own Claude Code: the main MCP server keeps one address and token in <userData>/mcp.json (0600),
// the file `claude --mcp-config` reads, so a Claude Code set up once still works after Shrike restarts.
// Shrike only offers these as text to copy; it never writes Claude Code's files.

const Saved = z.object({
  mcpServers: z.object({
    shrike: z.object({
      url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{2,5}\/mcp$/),
      headers: z.object({ Authorization: z.string().regex(/^Bearer [0-9a-f]{64}$/) }),
    }),
  }),
});

export async function readSaved(file: string): Promise<{ port: number; token: string } | undefined> {
  const raw = await readFile(file, "utf8").catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const got = Saved.safeParse(json);
  if (!got.success) return undefined;
  const { url, headers } = got.data.mcpServers.shrike;
  const port = Number(new URL(url).port);
  return port > 0 && port < 65536 ? { port, token: headers.Authorization.slice("Bearer ".length) } : undefined;
}

export async function saveConfig(file: string, url: string, token: string): Promise<void> {
  const config = { mcpServers: { shrike: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(tmp, file); // a fresh 0600 file every time, even if an older one was looser
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const addCommand = (url: string, token: string): string => `claude mcp add --transport http --scope user shrike ${url} --header "Authorization: Bearer ${token}"`;

export const configCommand = (file: string): string => `claude --mcp-config ${shellQuote(file)}`;

/** Claude Code settings that turn off its own file edits and shell, so code changes only through propose_patch. */
export const denySettings = (): string => JSON.stringify({ permissions: { deny: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] } }, null, 2);
