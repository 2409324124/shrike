// Wraps each function body: `return __shrike.run(id, args, () => { body })`.
// Runs at Program exit, after TypeScript is stripped, so only original JS functions (with loc) are wrapped.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedCode, generatedFile } from "./stack.mjs";

const FUNCTIONS = "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod";

function keyName(key, computed) {
  if (computed) return "[computed]";
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateName") return `#${key.id.name}`;
  if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value);
  return "anonymous";
}

// `ident` gives an identifier's original name (a bundler may have renamed `action` to `action5`).
function nameOf(path, ident = (id) => id.name) {
  const n = path.node;
  const p = path.parent;
  if (n.id) return ident(n.id);
  if (n.key) {
    const clsId = n.type.startsWith("Class") ? path.parentPath.parent.id : undefined;
    const cls = clsId && ident(clsId);
    return (cls ? cls + "." : "") + keyName(n.key, n.computed);
  }
  if (p.type === "VariableDeclarator" && p.init === n && p.id.type === "Identifier") return ident(p.id);
  if (p.type === "AssignmentExpression" && p.right === n) {
    if (p.left.type === "Identifier") return ident(p.left);
    if (p.left.type === "MemberExpression") return keyName(p.left.property, p.left.computed);
  }
  if ((p.type === "ObjectProperty" || p.type === "ClassProperty" || p.type === "ClassPrivateProperty") && p.value === n) {
    return keyName(p.key, p.computed);
  }
  if (p.type === "AssignmentPattern" && p.right === n && p.left.type === "Identifier") return ident(p.left);
  if (p.type === "ExportDefaultDeclaration") return "default";
  // catchAsync(async (req, res) => ...) and procedure.mutation(async () => ...) take the name they are given
  if (p.type === "CallExpression" && p.arguments.includes(n)) {
    const q = path.parentPath.parent;
    let given;
    if (q.type === "VariableDeclarator" && q.init === p && q.id.type === "Identifier") given = ident(q.id);
    else if ((q.type === "ObjectProperty" || q.type === "ClassProperty") && q.value === p) given = keyName(q.key, q.computed);
    if (given) return p.callee.type === "MemberExpression" && !p.callee.computed ? `${given} (${keyName(p.callee.property)})` : given;
  }
  // items.map((r) => ...) reads as "map callback"
  if (p.type === "CallExpression" && p.arguments.includes(n) && p.callee.type === "MemberExpression" && !p.callee.computed && p.callee.property.type === "Identifier") {
    return `${p.callee.property.name} callback`;
  }
  return "anonymous";
}

// True when the body redeclares a parameter with `var`: inside the arrow it would shadow the param.
function varShadowsParam(t, node) {
  const params = new Set();
  for (const p of node.params) for (const name of Object.keys(t.getBindingIdentifiers(p))) params.add(name);
  if (!params.size || node.body.type !== "BlockStatement") return false;
  let found = false;
  const walk = (n) => {
    if (found || !n || typeof n.type !== "string") return;
    if (t.isFunction(n) || n.type === "StaticBlock") return;
    if (n.type === "VariableDeclaration" && n.kind === "var") {
      for (const name of Object.keys(t.getBindingIdentifiers(n))) if (params.has(name)) found = true;
    }
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(node.body);
  return found;
}

// Rebuilds an arrow parameter as an expression of its bound values (arrows have no `arguments`).
function rebuild(t, p) {
  switch (p.type) {
    case "Identifier":
      return t.identifier(p.name);
    case "AssignmentPattern":
      return rebuild(t, p.left);
    case "RestElement":
      return t.spreadElement(rebuild(t, p.argument));
    case "ArrayPattern":
      return t.arrayExpression(p.elements.map((e) => (e ? rebuild(t, e) : null)));
    case "ObjectPattern":
      return t.objectExpression(
        p.properties.map((prop) =>
          prop.type === "RestElement"
            ? rebuild(t, prop)
            : t.objectProperty(prop.computed ? t.stringLiteral("[computed]") : t.cloneNode(prop.key), rebuild(t, prop.value)),
        ),
      );
    default:
      return t.identifier("undefined");
  }
}

const SECRET = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session/i; // preview.mjs SECRET

export default function shrikePlugin({ types: t }, opts) {
  const generated = new WeakSet();

  const visitor = {
    [FUNCTIONS](path, state) {
      const node = path.node;
      if (generated.has(node) || !node.loc || !node.body || node.generator) return;
      if ("kind" in node && node.kind !== "method") return;
      if (varShadowsParam(t, node)) return;
      if (node.type === "ArrowFunctionExpression" && !node.params.length && node.body.type === "Identifier") return; // a bundle's export getter (esbuild's `loader: () => loader`) is not a step

      const at = opts.locate
        ? opts.locate(node.loc.start.line, node.loc.start.column)
        : { file: opts.file, line: node.loc.start.line, column: node.loc.start.column + 1 };
      if (!at) return; // bundled code that isn't the user's own source

      const id = opts.idBase + state.defs.length;
      const name = nameOf(path, (id) => (opts.nameAt && id.loc && opts.nameAt(id.loc.start.line, id.loc.start.column)) || id.name);
      // Arguments that are secrets by their parameter name, or every argument of a password/secret function.
      const secret = node.params.flatMap((p, i) => (/password|secret/i.test(name) || (p.type === "Identifier" && SECRET.test(p.name)) ? [i] : []));
      state.defs.push({ id, ...at, name, ...(secret.length ? { secret } : {}) });

      const args =
        node.type === "ArrowFunctionExpression"
          ? t.arrayExpression(node.params.map((p) => rebuild(t, p)))
          : t.identifier("arguments");
      const innerBody = node.body.type === "BlockStatement" ? t.blockStatement(node.body.body) : node.body;
      const inner = t.arrowFunctionExpression([], innerBody, node.async);
      generated.add(inner);
      const call = t.callExpression(t.memberExpression(t.identifier("__shrike"), t.identifier("run")), [
        t.numericLiteral(id),
        args,
        inner,
      ]);
      const directives = node.body.type === "BlockStatement" ? node.body.directives : [];
      node.body = t.blockStatement([t.returnStatement(call)], directives);
      node.expression = false;
    },
  };

  return {
    name: "shrike",
    visitor: {
      Program: {
        exit(path, pass) {
          const state = { defs: [] };
          path.traverse(visitor, state);
          pass.file.metadata.shrikeDefs = state.defs;
          if (!state.defs.length) return;
          const def = t.expressionStatement(
            t.callExpression(t.memberExpression(t.identifier("__shrike"), t.identifier("def")), [
              t.numericLiteral(opts.fileIndex),
              t.valueToNode(state.defs),
            ]),
          );
          path.unshiftContainer("body", def);
        },
      },
    },
  };
}

const IDS_PER_FILE = 100_000; // transforms run concurrently, so each file gets its own id range
const require = createRequire(import.meta.url);
let babel;

// Repo-relative path of a source named in a source map (tsc, esbuild, webpack, Turbopack), else undefined.
function sourceRel(source, dir, root) {
  let file;
  if (source.startsWith("turbopack:///[project]/")) file = path.join(root, source.slice(23));
  else if (/^webpack:\/\/[^/]*\//.test(source)) file = path.resolve(root, source.replace(/^webpack:\/\/[^/]*\//, ""));
  else if (source.startsWith("file:")) file = fileURLToPath(source);
  else if (/^[a-z][\w+.-]*:/i.test(source)) return undefined;
  else file = path.resolve(dir, source);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  return parts.includes("node_modules") || parts[0].startsWith(".") || generatedFile(file) ? undefined : parts.join("/");
}

// The file's own source map (inline or next to it), when it was compiled or bundled from other sources.
function sourceMapOf(code, file) {
  const at = code.lastIndexOf("sourceMappingURL=");
  const ref = at >= 0 && code.length - at < 2000 ? /^sourceMappingURL=(\S+)/.exec(code.slice(at))?.[1] : undefined;
  // Some Turbopack chunks have a .map next to them but no comment.
  if (!ref) return existsSync(file + ".map") ? JSON.parse(readFileSync(file + ".map", "utf8")) : undefined;
  const data = /^data:application\/json[^,]*?(;base64)?,(.*)$/.exec(ref);
  const text = data ? Buffer.from(data[2], data[1] ? "base64" : "utf8").toString("utf8") : readFileSync(path.resolve(path.dirname(file), decodeURIComponent(ref)), "utf8");
  return JSON.parse(data && !data[1] ? decodeURIComponent(text) : text);
}

const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));

// VLQ mappings to decoded lines of [column, source, line, column, name?] segments.
function decode(mappings) {
  const lines = [];
  let src = 0;
  let oLine = 0;
  let oCol = 0;
  let name = 0;
  for (const text of mappings.split(";")) {
    const line = [];
    let col = 0;
    for (const seg of text.split(",")) {
      if (!seg) continue;
      const v = [];
      let shift = 0;
      let value = 0;
      for (const ch of seg) {
        const d = B64[ch];
        value += (d & 31) * 2 ** shift;
        if (d & 32) shift += 5;
        else {
          v.push(value % 2 ? -Math.floor(value / 2) : value / 2);
          value = shift = 0;
        }
      }
      col += v[0];
      if (v.length < 4) line.push([col]);
      else {
        src += v[1];
        oLine += v[2];
        oCol += v[3];
        if (v.length > 4) name += v[4];
        line.push(v.length > 4 ? [col, src, oLine, oCol, name] : [col, src, oLine, oCol]);
      }
    }
    lines.push(line);
  }
  return lines;
}

// One decoded map, also from an index map with sections (Turbopack). Babel takes decoded mappings as its input map.
function flatten(payload) {
  if (!payload.sections) {
    const root = payload.sourceRoot ? payload.sourceRoot.replace(/\/?$/, "/") : "";
    const sources = (payload.sources ?? []).map((s) => (s && root && !/^([a-z][\w+.-]*:|\/)/i.test(s) ? root + s : s));
    return { version: 3, sources, names: payload.names ?? [], mappings: decode(payload.mappings ?? "") };
  }
  const out = { version: 3, sources: [], names: [], mappings: [] };
  for (const { offset, map } of payload.sections) {
    const f = flatten(map);
    const sb = out.sources.length;
    const nb = out.names.length;
    out.sources.push(...f.sources);
    out.names.push(...f.names);
    f.mappings.forEach((line, i) => {
      while (out.mappings.length <= offset.line + i) out.mappings.push([]);
      const shift = i ? 0 : offset.column;
      out.mappings[offset.line + i].push(
        ...line.map((g) => (g.length < 4 ? [g[0] + shift] : [g[0] + shift, g[1] + sb, g[2], g[3], ...(g.length > 4 ? [g[4] + nb] : [])])),
      );
    });
  }
  return out;
}

// Maps generated positions back to the user's sources. Undefined: no map. Null: the map has no user sources (vendor bundle).
function locatorFor(code, file, root) {
  let map;
  try {
    const payload = root && sourceMapOf(code, file);
    if (payload) map = flatten(payload);
  } catch {}
  if (!map) return undefined;
  const dir = path.dirname(file);
  const rels = map.sources.map((s) => (s ? sourceRel(s, dir, root) : undefined));
  if (!rels.some(Boolean)) return null;
  return {
    map,
    locate(line, column) {
      let hit;
      for (const g of map.mappings[line - 1] ?? []) {
        if (g[0] > column) break;
        hit = g;
      }
      const file = hit && hit.length > 1 ? rels[hit[1]] : undefined;
      return file && { file, line: hit[2] + 1, column: hit[3] + 1 };
    },
    // The original name of the identifier generated at exactly this position, when the map records one.
    nameAt(line, column) {
      const g = map.mappings[line - 1]?.find((g) => g[0] === column);
      return g?.length > 4 ? map.names[g[4]] : undefined;
    },
  };
}

function options(code, file, rel, fileIndex, { root, script } = {}) {
  const isTs = !script && (file.endsWith(".ts") || file.endsWith(".mts"));
  const located = locatorFor(code, file, root);
  if (located === null) return undefined;
  // Without a map, build output (.next) and generated files are not the user's source either.
  if (!located && root && (rel.split("/")[0].startsWith(".") || generatedCode(code))) return undefined;
  return {
    filename: file,
    sourceFileName: file,
    sourceType: script ? "script" : "module",
    parserOpts: { allowReturnOutsideFunction: true },
    inputSourceMap: located?.map ?? true,
    sourceMaps: "inline",
    babelrc: false,
    configFile: false,
    browserslistConfigFile: false,
    compact: false,
    // ponytail: onlyRemoveTypeImports true matches Node's own type stripping (keeps value imports and their side effects).
    plugins: [
      ...(isTs ? [[babel.ts, { allowDeclareFields: true, onlyRemoveTypeImports: true }]] : []),
      [shrikePlugin, { file: rel, fileIndex, idBase: fileIndex * IDS_PER_FILE, locate: located?.locate, nameAt: located?.nameAt }],
    ],
  };
}

// Strips TypeScript (for .ts/.mts) and applies the Shrike plugin. `rel` is the repo-relative path.
// With `root`, a compiled or bundled file's source map decides which functions are the user's and where they are.
// Returns the code unchanged when nothing in it is the user's.
export async function transform(code, file, rel, fileIndex, opts) {
  babel ??= {
    core: (await import("@babel/core")).default,
    ts: (await import("@babel/plugin-transform-typescript")).default,
  };
  const o = options(code, file, rel, fileIndex, opts);
  return o ? (await babel.core.transformAsync(code, o)).code : code;
}

// Same, synchronously, for CommonJS (Module.prototype._compile). `code` is already JavaScript.
export function transformSync(code, file, rel, fileIndex, root) {
  babel ??= { core: require("@babel/core"), ts: require("@babel/plugin-transform-typescript").default };
  const o = options(code, file, rel, fileIndex, { root, script: true });
  return o ? babel.core.transformSync(code, o).code : code;
}
