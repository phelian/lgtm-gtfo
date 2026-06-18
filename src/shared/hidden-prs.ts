import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path/join";
import { cachedGhPrView, PR_FIELDS } from "./pr-cache.ts";

const HIDDEN_FILE = "hidden.json";

const getHiddenPath = async () => {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const dir = join(home, ".config", "lgtm-gtfo");
  await ensureDir(dir);
  return join(dir, HIDDEN_FILE);
};

export const loadHiddenPrs = async (): Promise<Set<string>> => {
  try {
    const path = await getHiddenPath();
    const text = await Deno.readTextFile(path);
    const arr: string[] = JSON.parse(text);
    return new Set(arr);
  } catch {
    return new Set();
  }
};

export const saveHiddenPrs = async (hidden: Set<string>): Promise<void> => {
  const path = await getHiddenPath();
  await Deno.writeTextFile(
    path,
    JSON.stringify([...hidden].sort(), null, 2) + "\n",
  );
};

const parsePrUrl = (url: string): { repo: string; number: number } | null => {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { repo: m[1], number: parseInt(m[2], 10) };
};

export const cleanupHidden = async (
  hidden: Set<string>,
): Promise<number> => {
  let removed = 0;
  for (const url of [...hidden]) {
    const parsed = parsePrUrl(url);
    if (!parsed) {
      hidden.delete(url);
      removed++;
      continue;
    }
    const result = await cachedGhPrView(
      parsed.repo,
      parsed.number,
      PR_FIELDS,
      false,
    );
    if (!result.ok) {
      hidden.delete(url);
      removed++;
      continue;
    }
    try {
      const data = JSON.parse(result.data);
      if (data.state !== "OPEN") {
        hidden.delete(url);
        removed++;
      }
    } catch {
      // leave it
    }
  }
  return removed;
};
