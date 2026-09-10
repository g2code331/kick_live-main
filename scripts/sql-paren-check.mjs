#!/usr/bin/env node
// A tiny SQL paren checker for the sandbox without Postgres: strips `-- …` line comments, `/* … */` blocks and
// single-quoted literals (with '' escapes), then reports the running balance per `create … as $fn$ … $fn$;`
// body. It cannot find a semantic error, and it does not claim to; what it does find is the class of mistake
// that turns a migration into a syntax error at 3 a.m. on the way to a first deploy.
import fs from "node:fs";

const file = process.argv[2] ?? "supabase/migrations/20260915120000_phase9_observability.sql";
const raw = fs.readFileSync(file, "utf8");

const strip = (text) => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === "--") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const stripped = strip(raw);
const bodies = [...stripped.matchAll(/create or replace function public\.([a-z_]+)\([\s\S]*?as \$fn\$([\s\S]*?)\$fn\$/g)];
let bad = 0;
const bracesOf = (name) => {
  // The body of a `create trigger … execute function name` is not this function, and `create table` bodies
  // contain parentheses that balance within the statement; only function bodies are checked here.
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)as \\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(stripped);
  return m ? m[2] : "";
};
for (const match of bodies) {
  const name = match[1];
  const body = bracesOf(name) || match[2];
  let depth = 0;
  let min = 0;
  let line = 1;
  let where = null;
  for (const ch of body) {
    if (ch === "\n") line++;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0 && where === null) where = line;
    }
    if (depth < min) min = depth;
  }
  if (depth !== 0 || min < 0) {
    bad++;
    console.log(`✖ ${name}: balance ${String(depth)} (min ${String(min)}, first negative near body line ${String(where ?? "n/a")})`);
  }
}
console.log(`${bodies.length} function bodies checked, ${String(bad)} unbalanced`);
process.exit(bad === 0 ? 0 : 1);
