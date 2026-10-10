import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Effort, UsageInput } from "./claude-code.ts";
import { toolResultStep, toolUseStep, type StepInput } from "./steps.ts";

export const BUILTIN_MODEL = "claude-sonnet-5";
const MAX_TURNS = 30;
const TOOL_TIMEOUT_MS = 600_000;
const CONTEXT_LIMIT = 200_000; // ponytail: claude-sonnet-5's default window; read it from the models API if it changes

export interface AnthropicLike {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): PromiseLike<Anthropic.Message>;
  };
}

// Returns true when the run failed.
export async function runBuiltin(o: {
  goal: string;
  system: string;
  mcp: { url: string; token: string };
  emit: (s: StepInput) => void;
  signal: AbortSignal;
  anthropic?: AnthropicLike;
  onUsage?(u: UsageInput): void;
  effort?: Effort;
  history?: Anthropic.MessageParam[]; // C1: a branch starts from the parent's messages (already ending in its question)
  onTurn?(messages: Anthropic.MessageParam[]): void; // C1: after each finished turn, so a later branch can cut here
  deny?: readonly string[]; // C3/C6: tools a read-only run never sees or calls
}): Promise<boolean> {
  const anthropic = o.anthropic ?? new Anthropic();
  const client = new Client({ name: "shrike-builtin", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(o.mcp.url), {
    requestInit: { headers: { Authorization: `Bearer ${o.mcp.token}`, "x-shrike-internal": "1" } },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const defs: Anthropic.Tool[] = tools.filter((t) => !o.deny?.includes(t.name)).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const last = defs.at(-1);
    if (last) last.cache_control = { type: "ephemeral" };

    const messages: Anthropic.MessageParam[] = o.history?.length ? [...o.history] : [{ role: "user", content: o.goal }];
    const usage: UsageInput = { inputTokens: 0, outputTokens: 0, contextLimit: CONTEXT_LIMIT };
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (o.signal.aborted) return false;
      const res = await anthropic.messages.create(
        {
          model: BUILTIN_MODEL,
          max_tokens: 4096,
          system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
          tools: defs,
          messages,
          // ponytail: output_config isn't in SDK 0.65's types yet; the API accepts it. Drop the cast after an SDK bump.
          ...(o.effort ? ({ output_config: { effort: o.effort } } as object) : {}),
        },
        { signal: o.signal },
      );
      if (o.signal.aborted) return false;
      messages.push({ role: "assistant", content: res.content });
      if (res.usage) {
        const u = res.usage;
        const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        usage.inputTokens += prompt;
        usage.outputTokens += u.output_tokens ?? 0;
        usage.contextTokens = prompt + (u.output_tokens ?? 0);
        o.onUsage?.({ ...usage });
      }

      const uses: Anthropic.ToolUseBlock[] = [];
      for (const b of res.content) {
        if (b.type === "text" && b.text.trim()) o.emit({ kind: "message", text: b.text.trim() });
        else if (b.type === "tool_use") {
          uses.push(b);
          o.emit(toolUseStep(b.name, b.input));
        }
      }
      if (res.stop_reason !== "tool_use" || !uses.length) {
        o.emit({ kind: "done", text: "Done" });
        o.onTurn?.(messages);
        return false;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        let text: string;
        let isError: boolean;
        try {
          if (o.deny?.includes(u.name)) throw new Error("this run is read-only");
          const r = await client.callTool({ name: u.name, arguments: u.input as Record<string, unknown> }, undefined, {
            timeout: TOOL_TIMEOUT_MS,
            signal: o.signal,
          });
          const content = (r.content ?? []) as { type: string; text?: string }[];
          text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
          isError = r.isError === true;
        } catch (err) {
          if (o.signal.aborted) return false;
          text = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        o.emit(toolResultStep(u.name, text, isError));
        results.push({ type: "tool_result", tool_use_id: u.id, content: text, is_error: isError });
      }
      messages.push({ role: "user", content: results });
      o.onTurn?.(messages);
    }
    o.emit({ kind: "error", text: `The agent hit its ${MAX_TURNS}-step limit before finishing.` });
    return true;
  } catch (err) {
    if (o.signal.aborted) return false;
    o.emit({ kind: "error", text: `The built-in agent stopped: ${err instanceof Error ? err.message : String(err)}` });
    return true;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}
