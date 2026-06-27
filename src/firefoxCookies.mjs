/**
 * Firefox cookie extraction for Gemini web.
 *
 * Firefox stores cookies in plaintext inside cookies.sqlite (table moz_cookies),
 * unlike Chrome which encrypts values with the OS keychain. We copy the DB to a
 * temp dir (Firefox holds a WAL lock) and read the google.com auth cookies.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";

// Google auth cookies Gemini web needs (named set is sufficient for text + image gen).
const GEMINI_COOKIE_NAMES = [
  "__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC", "__Secure-1PAPISID",
  "NID", "AEC", "SOCS", "__Secure-BUCKET", "__Secure-ENID",
  "SID", "HSID", "SSID", "APISID", "SAPISID",
  "__Secure-3PSID", "__Secure-3PSIDTS", "__Secure-3PAPISID", "SIDCC",
];
const GEMINI_REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

function resolveCookieDomain(cookie) {
  const rawDomain = cookie.domain?.trim();
  if (rawDomain) return rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
  const rawUrl = cookie.url?.trim();
  if (rawUrl) {
    try { return new URL(rawUrl).hostname; } catch { return null; }
  }
  return null;
}

function pickCookieValue(cookies, name) {
  const matches = cookies.filter((c) => c.name === name && typeof c.value === "string");
  if (matches.length === 0) return undefined;
  const preferred = matches.find((c) => resolveCookieDomain(c) === "google.com" && (c.path ?? "/") === "/");
  const googleDomain = matches.find((c) => (resolveCookieDomain(c) ?? "").endsWith("google.com"));
  return (preferred ?? googleDomain ?? matches[0])?.value;
}

export function buildGeminiCookieMap(cookies) {
  const map = {};
  for (const name of GEMINI_COOKIE_NAMES) {
    const value = pickCookieValue(cookies, name);
    if (value) map[name] = value;
  }
  return map;
}

export function hasRequiredGeminiCookies(map) {
  return GEMINI_REQUIRED_COOKIES.every((name) => Boolean(map[name]));
}

/** Default Firefox Profiles directory for the current platform. */
export function defaultFirefoxProfilesRoot() {
  const home = os.homedir();
  switch (os.platform()) {
    case "darwin": return path.join(home, "Library", "Application Support", "Firefox", "Profiles");
    case "win32": return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles");
    default: return path.join(home, ".mozilla", "firefox");
  }
}

/**
 * Resolve a Firefox profile directory.
 * Priority: explicit path → profile name under default root → auto-detect
 * the most recently used *.default-release (or *.default) profile.
 */
export function resolveFirefoxProfile(requested) {
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  if (trimmed) {
    const dir = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    if (existsSync(path.join(dir, "cookies.sqlite"))) return { profileDir: dir, source: "explicit-path" };
    const root = defaultFirefoxProfilesRoot();
    if (root) {
      const byName = path.join(root, trimmed);
      if (existsSync(path.join(byName, "cookies.sqlite"))) return { profileDir: byName, source: "explicit-name" };
    }
    return { profileDir: dir, source: "explicit-path" };
  }
  const root = defaultFirefoxProfilesRoot();
  if (!root || !existsSync(root)) return null;
  let best = null;
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    if (!existsSync(path.join(dir, "cookies.sqlite"))) continue;
    const isDefault = entry.endsWith(".default-release") || entry.endsWith(".default");
    let mtimeMs = 0;
    try { mtimeMs = statSync(dir).mtimeMs; } catch { continue; }
    if (!best || (isDefault && !best.isDefault) || (isDefault === best.isDefault && mtimeMs > best.mtimeMs)) {
      best = { dir, mtimeMs, isDefault };
    }
  }
  return best ? { profileDir: best.dir, source: "auto" } : null;
}

/** Query google.com cookies from a copied cookies.sqlite. */
export function readGeminiCookiesFromFirefoxDb(dbPath, options = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const wantContainer = options.userContextId != null && options.userContextId !== "";
    const sql = wantContainer
      ? "SELECT name, value, host, path, originAttributes FROM moz_cookies " +
        "WHERE host LIKE '%google.com' AND originAttributes LIKE ? " +
        "ORDER BY (originAttributes = ?) DESC, host, path"
      : "SELECT name, value, host, path, originAttributes FROM moz_cookies " +
        "WHERE host LIKE '%google.com' ORDER BY (originAttributes = '') DESC, host, path";
    const stmt = db.prepare(sql);
    const rows = wantContainer
      ? stmt.all(`%userContextId=${options.userContextId}%`, `^userContextId=${options.userContextId}`)
      : stmt.all();
    return { rows, warnings: [] };
  } catch (error) {
    return { rows: [], warnings: [`Firefox cookie read failed: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Load Gemini auth cookies from Firefox.
 * @param {{ firefoxProfile?: string|null, firefoxContainer?: string|null }} opts
 */
export async function loadGeminiCookiesFromFirefox(opts = {}, log) {
  const resolved = resolveFirefoxProfile(opts.firefoxProfile);
  if (!resolved) {
    log?.("[firefox] No Firefox profile found. Sign into gemini.google.com in Firefox, or pass --profile.");
    return { cookieMap: {}, warnings: ["No Firefox profile found."] };
  }
  const cookiesDb = path.join(resolved.profileDir, "cookies.sqlite");
  if (!existsSync(cookiesDb)) {
    log?.(`[firefox] cookies.sqlite not found at ${cookiesDb}`);
    return { cookieMap: {}, warnings: [`cookies.sqlite not found at ${cookiesDb}`] };
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gemini-ff-cookies-"));
  try {
    await copyFile(cookiesDb, path.join(tmpDir, "cookies.sqlite"));
    const wal = path.join(resolved.profileDir, "cookies.sqlite-wal");
    if (existsSync(wal)) await copyFile(wal, path.join(tmpDir, "cookies.sqlite-wal")).catch(() => {});
    const { rows, warnings } = readGeminiCookiesFromFirefoxDb(path.join(tmpDir, "cookies.sqlite"), {
      userContextId: opts.firefoxContainer ?? undefined,
    });
    if (warnings.length > 0) return { cookieMap: {}, warnings };
    const cookieMap = buildGeminiCookieMap(rows.map((r) => ({ name: r.name, value: r.value, domain: r.host, path: r.path })));
    if (hasRequiredGeminiCookies(cookieMap)) {
      log?.(`[firefox] Loaded ${Object.keys(cookieMap).length} cookie(s) from ${resolved.source} profile: ${path.basename(resolved.profileDir)}${opts.firefoxContainer ? ` (container ${opts.firefoxContainer})` : ""}`);
    } else {
      log?.(`[firefox] Profile ${path.basename(resolved.profileDir)} has no signed-in Google session (missing __Secure-1PSID/__Secure-1PSIDTS).`);
    }
    return { cookieMap, warnings: [] };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
