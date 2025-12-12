type PrState = "OPEN" | "CLOSED" | "MERGED";

type ReviewRequest = {
  login?: string;
  name?: string;
  slug?: string;
};

type PrInfo = {
  state: PrState;
  author: { login: string };
  body: string;
  reviewRequests: ReviewRequest[];
};

export type PrCheckResult = {
  repo: string;
  prNumber: number;
  state: PrState;
  isMerged: boolean;
  wasRequestedReviewer: boolean;
  wasMentioned: boolean;
  error?: string;
};

const cache = new Map<string, PrCheckResult>();

const createUserCache = () => {
  let cachedUser: string | null = null;

  return async (): Promise<string> => {
    if (cachedUser) {
      return cachedUser;
    }

    const envHandle = Deno.env.get("GITHUB_HANDLE");
    if (envHandle) {
      cachedUser = envHandle;
      console.log(`Using GitHub handle: ${cachedUser}`);
      return cachedUser;
    }

    const command = new Deno.Command("gh", {
      args: ["api", "user", "--jq", ".login"],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const error = new TextDecoder().decode(stderr);
      throw new Error(
        `Failed to get current user: ${error}. Set GITHUB_HANDLE env var to specify your username.`,
      );
    }

    cachedUser = new TextDecoder().decode(stdout).trim();
    console.log(`Using GitHub handle: ${cachedUser}`);
    return cachedUser;
  };
};

export const getGitHubUser = createUserCache();

export const checkPr = async (
  repo: string,
  prNumber: number,
): Promise<PrCheckResult> => {
  const cacheKey = `${repo}#${prNumber}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const user = await getGitHubUser();

  const command = new Deno.Command("gh", {
    args: [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,author,body,reviewRequests",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    const result: PrCheckResult = {
      repo,
      prNumber,
      state: "CLOSED",
      isMerged: false,
      wasRequestedReviewer: false,
      wasMentioned: false,
      error: error.includes("Could not resolve")
        ? "PR not found"
        : error.trim(),
    };
    cache.set(cacheKey, result);
    return result;
  }

  const prInfo: PrInfo = JSON.parse(new TextDecoder().decode(stdout));

  const wasRequestedReviewer = prInfo.reviewRequests.some(
    (r) => r.login?.toLowerCase() === user.toLowerCase(),
  );

  const mentionPattern = new RegExp(`@${user}\\b`, "i");
  const wasMentioned = mentionPattern.test(prInfo.body ?? "");

  const result: PrCheckResult = {
    repo,
    prNumber,
    state: prInfo.state,
    isMerged: prInfo.state === "MERGED",
    wasRequestedReviewer,
    wasMentioned,
  };

  cache.set(cacheKey, result);
  return result;
};

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (const [index, item] of items.entries()) {
    const promise = (async () => {
      results[index] = await fn(item);
    })();

    executing.add(promise);
    promise.finally(() => executing.delete(promise));

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
};

export const batchCheckPrs = async (
  prs: Array<{ repo: string; prNumber: number }>,
): Promise<Map<string, PrCheckResult>> => {
  const results = new Map<string, PrCheckResult>();
  const uniqueKeys = [...new Set(prs.map((p) => `${p.repo}#${p.prNumber}`))];
  const uniquePrs = uniqueKeys.map((key) => {
    const [repo, prNumStr] = key.split("#");
    return { repo, prNumber: parseInt(prNumStr, 10), key };
  });

  console.log(`Checking ${uniquePrs.length} unique PRs...`);

  const concurrency = 10;
  let checked = 0;

  const checkResults = await runWithConcurrency(
    uniquePrs,
    concurrency,
    async ({ repo, prNumber, key }) => {
      const result = await checkPr(repo, prNumber);
      checked++;
      if (checked % 10 === 0 || checked === uniquePrs.length) {
        console.log(`Checked ${checked}/${uniquePrs.length} PRs`);
      }
      return { key, result };
    },
  );

  for (const { key, result } of checkResults) {
    results.set(key, result);
  }

  return results;
};

type PendingPr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  approvalsNeeded: number;
  approvals: number;
};

type PendingReviewsOptions = {
  excludeBots?: boolean;
};

const BOT_AUTHORS = ["dependabot", "es-robot"];

export const listPendingReviews = async (
  options: PendingReviewsOptions = {},
): Promise<void> => {
  const user = await getGitHubUser();

  console.log(`\nFetching PRs awaiting review from ${user}...\n`);

  const command = new Deno.Command("gh", {
    args: [
      "search",
      "prs",
      "--review-requested",
      user,
      "--state",
      "open",
      "--json",
      "repository,number,title,url,author",
      "--limit",
      "100",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    console.error(`Failed to fetch pending reviews: ${error}`);
    return;
  }

  type SearchResult = {
    repository: { nameWithOwner: string };
    number: number;
    title: string;
    url: string;
    author: { login: string };
  };

  let results: SearchResult[] = JSON.parse(new TextDecoder().decode(stdout));

  if (options.excludeBots) {
    const before = results.length;
    results = results.filter(
      (pr) => !BOT_AUTHORS.some(bot => pr.author.login.toLowerCase().includes(bot)),
    );
    if (before !== results.length) {
      console.log(`Excluded ${before - results.length} bot PRs`);
    }
  }

  if (results.length === 0) {
    console.log("No PRs awaiting your review.");
    return;
  }

  console.log(`Found ${results.length} PRs, fetching details...`);

  let processed = 0;

  const fetchPrDetails = async (
    pr: SearchResult,
  ): Promise<PendingPr | null> => {
    const detailCmd = new Deno.Command("gh", {
      args: [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        pr.repository.nameWithOwner,
        "--json",
        "reviews,reviewDecision",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const detail = await detailCmd.output();

    processed++;
    const pct = Math.round((processed / results.length) * 100);
    Deno.stdout.writeSync(
      new TextEncoder().encode(`\r  [${processed}/${results.length}] ${pct}%`),
    );

    if (detail.code !== 0) return null;

    type ReviewDetail = {
      reviews: Array<{ author: { login: string }; state: string }>;
      reviewDecision: string;
    };

    const reviewData: ReviewDetail = JSON.parse(
      new TextDecoder().decode(detail.stdout),
    );

    const approvals = reviewData.reviews.filter(
      (r) => r.state === "APPROVED",
    ).length;

    const approvalsNeeded = reviewData.reviewDecision === "APPROVED"
      ? 0
      : reviewData.reviewDecision === "CHANGES_REQUESTED"
      ? -1
      : Math.max(0, 2 - approvals);

    return {
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      approvalsNeeded,
      approvals,
    };
  };

  const prResults = await runWithConcurrency(results, 10, fetchPrDetails);
  const pendingPrs = prResults.filter((p): p is PendingPr => p !== null);

  console.log("\n");

  const needsOneApproval = pendingPrs.filter((p) => p.approvalsNeeded === 1);
  const changesRequested = pendingPrs.filter((p) => p.approvalsNeeded === -1);
  const needsMoreApprovals = pendingPrs.filter((p) => p.approvalsNeeded > 1);
  const approved = pendingPrs.filter((p) => p.approvalsNeeded === 0);

  if (needsOneApproval.length > 0) {
    console.log(`${"=".repeat(60)}`);
    console.log(`🔥 NEEDS 1 MORE APPROVAL (${needsOneApproval.length}):\n`);
    for (const pr of needsOneApproval) {
      console.log(`  ${pr.repo}#${pr.number}`);
      console.log(`    ${pr.title}`);
      console.log(`    by ${pr.author} | ${pr.url}`);
      console.log();
    }
  }

  if (needsMoreApprovals.length > 0) {
    console.log(`${"=".repeat(60)}`);
    console.log(`⏳ NEEDS MORE APPROVALS (${needsMoreApprovals.length}):\n`);
    for (const pr of needsMoreApprovals) {
      console.log(`  ${pr.repo}#${pr.number} (${pr.approvals} approvals)`);
      console.log(`    ${pr.title}`);
      console.log(`    by ${pr.author} | ${pr.url}`);
      console.log();
    }
  }

  if (changesRequested.length > 0) {
    console.log(`${"=".repeat(60)}`);
    console.log(`🔄 CHANGES REQUESTED (${changesRequested.length}):\n`);
    for (const pr of changesRequested) {
      console.log(`  ${pr.repo}#${pr.number}`);
      console.log(`    ${pr.title}`);
      console.log(`    by ${pr.author} | ${pr.url}`);
      console.log();
    }
  }

  if (approved.length > 0) {
    console.log(`${"=".repeat(60)}`);
    console.log(`✅ APPROVED (waiting to merge) (${approved.length}):\n`);
    for (const pr of approved) {
      console.log(`  ${pr.repo}#${pr.number}`);
      console.log(`    ${pr.title}`);
      console.log(`    by ${pr.author} | ${pr.url}`);
      console.log();
    }
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`\nTotal: ${pendingPrs.length} PRs awaiting your review`);
};
