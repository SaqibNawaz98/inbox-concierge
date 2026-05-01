/**
 * Validates env files for local / self-hosted runs (same vars Next loads from .env*).
 * Usage: npm run check-env   (from repo root)
 */

import fs from "node:fs";

const root = process.cwd();

type EnvMap = Record<string, string>;

function parseDotEnv(contents: string): EnvMap {
  const out: EnvMap = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnvFile(name: string): EnvMap {
  const filePath = `${root}/${name}`;
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return parseDotEnv(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function isUnset(value: string | undefined): boolean {
  return value == null || String(value).trim() === "";
}

function looksLikePlaceholder(key: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "changeme" || v === "replace_me") {
    return true;
  }
  if (key.startsWith("GOOGLE_") && v.includes("your-google")) {
    return true;
  }
  if (key === "OPENAI_API_KEY" && (v === "sk-..." || v.startsWith("your-"))) {
    return true;
  }
  return false;
}

function mergeFileEnv(files: EnvMap[]): EnvMap {
  const merged: EnvMap = {};
  for (const f of files) {
    Object.assign(merged, f);
  }
  return merged;
}

function pickEnv(merged: EnvMap, keys: readonly string[]): EnvMap {
  const resolved: EnvMap = {};
  for (const key of keys) {
    const fromProcess = process.env[key];
    if (!isUnset(fromProcess)) {
      resolved[key] = String(fromProcess).trim();
    } else if (!isUnset(merged[key])) {
      resolved[key] = merged[key]!.trim();
    }
  }
  return resolved;
}

function tryParseUrl(label: string, value: string): string | null {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) {
      return `${label} must use http: or https:`;
    }
  } catch {
    return `${label} is not a valid URL`;
  }
  return null;
}

const REQUIRED = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "NEXT_PUBLIC_APP_URL",
] as const;

const OPTIONAL: { key: string; hint: string }[] = [
  {
    key: "LLM_API_KEY",
    hint: "Server default LLM key; optional if you use the in-app settings (gear) instead",
  },
  {
    key: "OPENAI_API_KEY",
    hint: "Alias for LLM key; optional if using LLM_API_KEY or the app settings dialog",
  },
  { key: "DATABASE_URL", hint: "Postgres for learning + saved custom buckets" },
];

function main(): void {
  const mergedFiles = mergeFileEnv([loadEnvFile(".env"), loadEnvFile(".env.local")]);
  const keysToRead = [
    ...REQUIRED,
    ...OPTIONAL.map((o) => o.key),
  ] as string[];
  const fromFiles = pickEnv(mergedFiles, keysToRead);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of REQUIRED) {
    const value = fromFiles[key];
    if (isUnset(value)) {
      errors.push(`Missing required: ${key} (set in .env.local or environment)`);
      continue;
    }
    if (looksLikePlaceholder(key, value!)) {
      errors.push(`Required ${key} still looks like a placeholder — replace with real credentials`);
    }
  }

  const appUrl = fromFiles.NEXT_PUBLIC_APP_URL;
  const redirect = fromFiles.GOOGLE_REDIRECT_URI;
  if (!isUnset(appUrl)) {
    const msg = tryParseUrl("NEXT_PUBLIC_APP_URL", appUrl!);
    if (msg) {
      warnings.push(msg);
    }
  }
  if (!isUnset(redirect)) {
    const msg = tryParseUrl("GOOGLE_REDIRECT_URI", redirect!);
    if (msg) {
      warnings.push(msg);
    }
    if (
      !isUnset(appUrl) &&
      !isUnset(redirect) &&
      redirect!.includes("/api/auth/google/callback") &&
      !redirect!.startsWith(new URL(appUrl!).origin)
    ) {
      warnings.push(
        "GOOGLE_REDIRECT_URI origin differs from NEXT_PUBLIC_APP_URL — often intentional behind a proxy; verify Google Console redirect URIs match exactly.",
      );
    }
  }

  for (const { key, hint } of OPTIONAL) {
    if (isUnset(fromFiles[key])) {
      warnings.push(`Optional unset: ${key} — ${hint}`);
    }
  }

  if (!fs.existsSync(`${root}/.env.local`) && !fs.existsSync(`${root}/.env`)) {
    warnings.push("No .env or .env.local found — copy .env.example to .env.local");
  } else if (!fs.existsSync(`${root}/.env.local`)) {
    warnings.push("No .env.local — Next.js prefers .env.local for secrets (you may rely on .env only)");
  }

  console.log("Environment check (required for Gmail OAuth + app URL)\n");
  if (errors.length === 0) {
    console.log("Required variables: OK\n");
  } else {
    console.log("Issues:\n");
    for (const e of errors) {
      console.log(`  · ${e}`);
    }
    console.log("");
  }

  if (warnings.length > 0) {
    console.log("Notes:\n");
    for (const w of warnings) {
      console.log(`  · ${w}`);
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.log("Fix the items above, then run: npm run dev\n");
    process.exitCode = 1;
    return;
  }

  console.log("Ready to run: npm run dev\n");
}

main();
