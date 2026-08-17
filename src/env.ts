import fs from "node:fs";

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments. */
export function loadDotenv(file = ".env"): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function requireEnv(keys: string[]): void {
  for (const key of keys) {
    if (!process.env[key]) {
      console.error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
      process.exit(1);
    }
  }
}
