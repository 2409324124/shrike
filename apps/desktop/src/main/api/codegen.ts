// The request as code, after vars and auth are applied. The user's own values, for the user's clipboard.
import type { ApiCodeLang } from "@shrike/schema";
import type { Prepared } from "./exec.ts";

const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const py = (s: string) => JSON.stringify(s);
const isMultipart = (p: Prepared) => /multipart\/form-data/i.test(p.headers["content-type"] ?? "");

export function toCode(p: Prepared, lang: ApiCodeLang): string {
  const body = p.body?.toString("utf8");
  const headers = Object.entries(p.headers).filter(([k]) => !(isMultipart(p) && /^content-type$/i.test(k)));
  const url = p.url.href;
  const multipartNote = "multipart body: attach the files again, Shrike can't inline them";
  switch (lang) {
    case "curl": {
      const parts = [`curl${p.method === "GET" ? "" : ` -X ${p.method}`} ${sh(url)}`, ...headers.map(([k, v]) => `-H ${sh(`${k}: ${v}`)}`)];
      if (body !== undefined) parts.push(isMultipart(p) ? `# ${multipartNote}` : `--data-raw ${sh(body)}`);
      return parts.join(" \\\n  ");
    }
    case "fetch": {
      const init = [`  method: ${JSON.stringify(p.method)},`, `  headers: ${JSON.stringify(Object.fromEntries(headers), null, 2).replace(/\n/g, "\n  ")},`];
      if (body !== undefined) init.push(isMultipart(p) ? `  // ${multipartNote}` : `  body: ${JSON.stringify(body)},`);
      return `const res = await fetch(${JSON.stringify(url)}, {\n${init.join("\n")}\n});\nconsole.log(res.status, await res.text());`;
    }
    case "axios": {
      const cfg = [`  method: ${JSON.stringify(p.method.toLowerCase())},`, `  url: ${JSON.stringify(url)},`, `  headers: ${JSON.stringify(Object.fromEntries(headers), null, 2).replace(/\n/g, "\n  ")},`];
      if (body !== undefined) cfg.push(isMultipart(p) ? `  // ${multipartNote}` : `  data: ${JSON.stringify(body)},`);
      return `import axios from "axios";\n\nconst res = await axios({\n${cfg.join("\n")}\n});\nconsole.log(res.status, res.data);`;
    }
    case "python": {
      const lines = ["import requests", "", `headers = {${headers.map(([k, v]) => `\n    ${py(k)}: ${py(v)},`).join("")}${headers.length ? "\n" : ""}}`];
      if (body !== undefined && !isMultipart(p)) lines.push(`data = ${py(body)}`);
      lines.push("", `res = requests.request(${py(p.method)}, ${py(url)}, headers=headers${body !== undefined && !isMultipart(p) ? ", data=data.encode()" : ""})`, "print(res.status_code, res.text)");
      if (isMultipart(p)) lines.splice(3, 0, `# ${multipartNote}`);
      return lines.join("\n");
    }
    case "httpie": {
      const parts = [`http ${p.method} ${sh(url)}`, ...headers.map(([k, v]) => sh(`${k}:${v}`))];
      if (body === undefined) return parts.join(" \\\n  ");
      if (isMultipart(p)) return `${parts.join(" \\\n  ")}\n# ${multipartNote}`;
      return `printf %s ${sh(body)} | ${parts.join(" \\\n  ")}`;
    }
  }
}
