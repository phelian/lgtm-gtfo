import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path/join";

const CACHE_FILE = "pr-cache.json";
const TTL_OPEN_MS = 15 * 60 * 1000;
const TTL_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const PR_FIELDS =
  "state,isDraft,author,title,body,reviewRequests,autoMergeRequest,reviews,reviewDecision";

type CacheEntry = {
  data: string;
  cachedAt: number;
  state?: string;
};

const isTerminal = (state?: string): boolean =>
  state === "MERGED" || state === "CLOSED";

const ttlFor = (state?: string): number =>
  isTerminal(state) ? TTL_TERMINAL_MS : TTL_OPEN_MS;

const extractState = (data: string): string | undefined => {
  try {
    const obj = JSON.parse(data);
    return typeof obj.state === "string" ? obj.state : undefined;
  } catch {
    return undefined;
  }
};

const cache = new Map<string, CacheEntry>();
const state = { loaded: false, hits: 0, misses: 0 };

const getCachePath = async () => {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const dir = join(home, ".config", "lgtm-gtfo");
  await ensureDir(dir);
  return join(dir, CACHE_FILE);
};

export const loadPrCache = async (): Promise<void> => {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const path = await getCachePath();
    const text = await Deno.readTextFile(path);
    const obj: Record<string, CacheEntry> = JSON.parse(text);
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      const entryState = v.state ?? extractState(v.data);
      if (isTerminal(entryState) && now - v.cachedAt > MAX_AGE_MS) continue;
      if (!isTerminal(entryState) && now - v.cachedAt > TTL_OPEN_MS * 4) {
        continue;
      }
      cache.set(k, { ...v, state: entryState });
    }
  } catch {
    // no cache yet
  }
};

export const savePrCache = async (): Promise<void> => {
  if (!state.loaded) return;
  const path = await getCachePath();
  const obj: Record<string, CacheEntry> = {};
  for (const [k, v] of cache) obj[k] = v;
  await Deno.writeTextFile(path, JSON.stringify(obj));
};

export const clearPrCache = async (): Promise<void> => {
  cache.clear();
  try {
    const path = await getCachePath();
    await Deno.remove(path);
  } catch {
    // not present, fine
  }
};

export const getPrCacheStats = (): { hits: number; misses: number } => ({
  hits: state.hits,
  misses: state.misses,
});

export const printPrCacheStats = (): void => {
  const total = state.hits + state.misses;
  if (total === 0) return;
  const pct = Math.round((state.hits / total) * 100);
  console.log(
    `Cache: ${state.hits} hits, ${state.misses} misses (${pct}% hit rate)`,
  );
};

export type GhPrViewResult =
  | { ok: true; data: string; cached: boolean }
  | { ok: false; error: string };

export const cachedGhPrView = async (
  repo: string,
  prNumber: number,
  fields: string,
  force: boolean,
): Promise<GhPrViewResult> => {
  await loadPrCache();
  const key = `${repo}#${prNumber}#${fields}`;
  if (!force) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.cachedAt <= ttlFor(entry.state)) {
      state.hits++;
      return { ok: true, data: entry.data, cached: true };
    }
  }
  state.misses++;
  const cmd = new Deno.Command("gh", {
    args: ["pr", "view", String(prNumber), "--repo", repo, "--json", fields],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    return { ok: false, error: new TextDecoder().decode(stderr) };
  }
  const data = new TextDecoder().decode(stdout);
  cache.set(key, { data, cachedAt: Date.now(), state: extractState(data) });
  return { ok: true, data, cached: false };
};
