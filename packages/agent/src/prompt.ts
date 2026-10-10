import { readFile } from "node:fs/promises";
import path from "node:path";

export async function buildSystemPrompt(promptsDir: string, vars: Record<string, string | undefined>, file = "system.md"): Promise<string> {
  const template = (await readFile(path.join(promptsDir, file), "utf8")).replace(/<!--[\s\S]*?-->\n?/g, "");
  return fillTemplate(template, vars);
}

export function fillTemplate(template: string, vars: Record<string, string | undefined>): string {
  const missing = [...new Set([...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))].filter((k) => vars[k] === undefined);
  if (missing.length) throw new Error(`The agent prompt has unfilled variables: ${missing.map((k) => `{{${k}}}`).join(", ")}`);
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k]!);
}
