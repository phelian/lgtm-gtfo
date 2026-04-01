import { fetchGitHubEmails as fetchGraphEmails } from "../ms-graph/emails.ts";
import { fetchGitHubEmails as fetchEwsEmails } from "../ews/emails.ts";
import { fetchGitHubEmails as fetchMailAppEmails } from "../mail-app/emails.ts";
import type { UnifiedEmail } from "../shared/types.ts";

type Backend = "mail-app" | "graph" | "ews";

type PrState = "OPEN" | "CLOSED" | "MERGED";

type ReviewRequest = {
  login?: string;
  name?: string;
  slug?: string;
};

type PrInfo = {
  state: PrState;
  author: { login: string };
  title: string;
  body: string;
  reviewRequests: ReviewRequest[];
  autoMergeRequest: unknown | null;
};

export type PrCheckResult = {
  repo: string;
  prNumber: number;
  state: PrState;
  isMerged: boolean;
  isInMergeQueue: boolean;
  wasRequestedReviewer: boolean;
  wasMentioned: boolean;
  author?: string;
  title?: string;
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
      "state,author,title,body,reviewRequests,autoMergeRequest",
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
      isInMergeQueue: false,
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
    isInMergeQueue: prInfo.autoMergeRequest !== null,
    wasRequestedReviewer,
    wasMentioned,
    author: prInfo.author.login,
    title: prInfo.title,
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
  userApproved: boolean;
};

type PendingReviewsOptions = {
  excludeBots?: boolean;
  includeMine?: boolean;
  backend?: Backend;
  folder?: string;
  org?: string;
};

const getBotAuthors = (): string[] => {
  const envBots = Deno.env.get("LGTM_BOTS");
  if (envBots) {
    return envBots.split(",").map((b) => b.trim().toLowerCase());
  }
  return ["dependabot"];
};

const BOT_AUTHORS = getBotAuthors();

const fetchInboxEmails = async (
  backend: Backend,
  folder?: string,
): Promise<UnifiedEmail[]> => {
  switch (backend) {
    case "mail-app": {
      const mailEmails = await fetchMailAppEmails(folder);
      return mailEmails.map((e) => ({
        id: e.id,
        messageId: e.messageId,
        subject: e.subject,
        receivedDateTime: e.receivedDateTime,
        repo: e.repo,
        prNumber: e.prNumber,
        mailbox: e.mailbox,
        account: e.account,
      }));
    }
    case "graph":
      return fetchGraphEmails(folder);
    case "ews":
      return fetchEwsEmails(folder);
  }
};

export const listPendingReviews = async (
  options: PendingReviewsOptions = {},
): Promise<void> => {
  const user = await getGitHubUser();

  const org = options.org ?? Deno.env.get("LGTM_ORG");

  console.log(
    `\nFetching PRs${org ? ` for ${org}` : ""}...\n`,
  );

  const searchArgs = [
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
  ];
  if (org) {
    searchArgs.push("--owner", org);
  }

  const command = new Deno.Command("gh", {
    args: searchArgs,
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

  const results: SearchResult[] = JSON.parse(new TextDecoder().decode(stdout));

  const botCount = options.excludeBots
    ? results.filter((pr) =>
      BOT_AUTHORS.some((bot) => pr.author.login.toLowerCase().includes(bot))
    ).length
    : 0;
  if (botCount > 0) {
    console.log(
      `Checking ${botCount} bot PR(s) for personal review requests...`,
    );
  }

  const reviewRequestedKeys = new Set(
    results.map((r) => `${r.repository.nameWithOwner}#${r.number}`),
  );

  type InboxCandidate = {
    repo: string;
    number: number;
    author: string;
    title: string;
  };
  const inboxCandidates: InboxCandidate[] = [];

  if (options.backend) {
    console.log("Fetching inbox emails...");
    const emails = await fetchInboxEmails(options.backend, options.folder);
    const prEmails = emails.filter((e) => e.repo && e.prNumber);

    if (prEmails.length > 0) {
      console.log(`Checking ${prEmails.length} PR emails...`);
      const prResults = await batchCheckPrs(
        prEmails.map((e) => ({ repo: e.repo!, prNumber: e.prNumber! })),
      );

      const seen = new Set<string>();
      for (const email of prEmails) {
        const key = `${email.repo}#${email.prNumber}`;
        if (reviewRequestedKeys.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);

        const prResult = prResults.get(key);
        if (!prResult || prResult.error) continue;
        if (prResult.state !== "OPEN") continue;
        if (prResult.isInMergeQueue) continue;

        if (
          options.excludeBots &&
          prResult.author &&
          BOT_AUTHORS.some((bot) =>
            prResult.author!.toLowerCase().includes(bot)
          ) &&
          !prResult.wasRequestedReviewer
        ) {
          continue;
        }

        if (
          !options.includeMine &&
          prResult.author?.toLowerCase() === user.toLowerCase()
        ) {
          continue;
        }

        inboxCandidates.push({
          repo: email.repo!,
          number: email.prNumber!,
          author: prResult.author ?? "unknown",
          title: prResult.title ?? "",
        });
      }
    }
  }

  if (results.length === 0 && inboxCandidates.length === 0) {
    console.log("No pending PRs found.");
    return;
  }

  type PrToFetch = {
    repo: string;
    number: number;
    title: string;
    url: string;
    author: string;
  };

  const allPrsToFetch: PrToFetch[] = [
    ...results.map((r) => ({
      repo: r.repository.nameWithOwner,
      number: r.number,
      title: r.title,
      url: r.url,
      author: r.author.login,
    })),
    ...inboxCandidates.map((c) => ({
      repo: c.repo,
      number: c.number,
      title: c.title,
      url: `https://github.com/${c.repo}/pull/${c.number}`,
      author: c.author,
    })),
  ];

  if (allPrsToFetch.length > 0) {
    console.log(`Fetching details for ${allPrsToFetch.length} PRs...`);
  }

  let processed = 0;

  const fetchPrDetails = async (pr: PrToFetch): Promise<PendingPr | null> => {
    const detailCmd = new Deno.Command("gh", {
      args: [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        pr.repo,
        "--json",
        "reviews,reviewDecision,autoMergeRequest,reviewRequests",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const detail = await detailCmd.output();

    processed++;
    const pct = Math.round((processed / allPrsToFetch.length) * 100);
    Deno.stdout.writeSync(
      new TextEncoder().encode(
        `\r  [${processed}/${allPrsToFetch.length}] ${pct}%`,
      ),
    );

    if (detail.code !== 0) return null;

    type ReviewDetail = {
      reviews: Array<{ author: { login: string }; state: string }>;
      reviewDecision: string;
      autoMergeRequest: unknown | null;
      reviewRequests: Array<{ login?: string }>;
    };

    const reviewData: ReviewDetail = JSON.parse(
      new TextDecoder().decode(detail.stdout),
    );

    if (
      options.excludeBots &&
      BOT_AUTHORS.some((bot) => pr.author.toLowerCase().includes(bot))
    ) {
      const personallyRequested = reviewData.reviewRequests?.some(
        (r) => r.login?.toLowerCase() === user.toLowerCase(),
      );
      if (!personallyRequested) return null;
    }

    if (reviewData.autoMergeRequest !== null) return null;

    const approvals = reviewData.reviews.filter(
      (r) => r.state === "APPROVED",
    ).length;

    const userApproved = reviewData.reviews.some(
      (r) =>
        r.state === "APPROVED" &&
        r.author.login.toLowerCase() === user.toLowerCase(),
    );

    const approvalsNeeded = reviewData.reviewDecision === "APPROVED"
      ? 0
      : reviewData.reviewDecision === "CHANGES_REQUESTED"
      ? -1
      : Math.max(0, 2 - approvals);

    return {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      approvalsNeeded,
      approvals,
      userApproved,
    };
  };

  const prResults = await runWithConcurrency(allPrsToFetch, 10, fetchPrDetails);
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
      const youApproved = pr.userApproved ? " (you approved)" : "";
      console.log(`  ${pr.repo}#${pr.number}${youApproved}`);
      console.log(`    ${pr.title}`);
      console.log(`    by ${pr.author} | ${pr.url}`);
      console.log();
    }
  }

  if (needsMoreApprovals.length > 0) {
    console.log(`${"=".repeat(60)}`);
    console.log(`⏳ NEEDS MORE APPROVALS (${needsMoreApprovals.length}):\n`);
    for (const pr of needsMoreApprovals) {
      const youApproved = pr.userApproved ? " (you approved)" : "";
      console.log(
        `  ${pr.repo}#${pr.number} (${pr.approvals} approvals)${youApproved}`,
      );
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

  const myPrsArgs = [
    "search",
    "prs",
    "--author",
    user,
    "--state",
    "open",
    "--json",
    "repository,number,title,url,reviewDecision",
    "--limit",
    "50",
  ];
  if (org) {
    myPrsArgs.push("--owner", org);
  }

  const myPrsCmd = new Deno.Command("gh", {
    args: myPrsArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const myPrsResult = await myPrsCmd.output();

  type MyPrResult = {
    repository: { nameWithOwner: string };
    number: number;
    title: string;
    url: string;
    reviewDecision: string;
  };

  if (myPrsResult.code === 0) {
    const myPrs: MyPrResult[] = JSON.parse(
      new TextDecoder().decode(myPrsResult.stdout),
    );

    if (myPrs.length > 0) {
      console.log(`${"=".repeat(60)}`);
      console.log(`📝 YOUR OPEN PRs (${myPrs.length}):\n`);
      for (const pr of myPrs) {
        const status = pr.reviewDecision === "APPROVED"
          ? "✅ approved"
          : pr.reviewDecision === "CHANGES_REQUESTED"
          ? "🔄 changes requested"
          : pr.reviewDecision === "REVIEW_REQUIRED"
          ? "⏳ awaiting review"
          : "⚪ no reviews";
        console.log(`  ${status} ${pr.repository.nameWithOwner}#${pr.number}`);
        console.log(`    ${pr.title}`);
        console.log(`    ${pr.url}`);
        console.log();
      }
    }
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`\nTotal: ${pendingPrs.length} PRs to review`);
};

type MyPrsOptions = {
  org?: string;
};

type BotPrsOptions = {
  org?: string;
};

export const listMyPrs = async (options: MyPrsOptions = {}): Promise<void> => {
  const user = await getGitHubUser();
  const org = options.org ?? Deno.env.get("LGTM_ORG");

  console.log(`\nFetching your open PRs${org ? ` in ${org}` : ""}...\n`);

  const args = [
    "search",
    "prs",
    "--author",
    user,
    "--state",
    "open",
    "--json",
    "repository,number,title,url,createdAt",
    "--limit",
    "100",
  ];
  if (org) {
    args.push("--owner", org);
  }

  const command = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    console.error(`Failed to fetch PRs: ${error}`);
    return;
  }

  type SearchResult = {
    repository: { nameWithOwner: string };
    number: number;
    title: string;
    url: string;
    createdAt: string;
  };

  const searchResults: SearchResult[] = JSON.parse(
    new TextDecoder().decode(stdout),
  );

  if (searchResults.length === 0) {
    console.log("No open PRs found.");
    return;
  }

  console.log(`Found ${searchResults.length} PRs, fetching review status...`);

  type MyPr = SearchResult & { reviewDecision: string };

  let processed = 0;
  const fetchReviewStatus = async (pr: SearchResult): Promise<MyPr> => {
    const detailCmd = new Deno.Command("gh", {
      args: [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        pr.repository.nameWithOwner,
        "--json",
        "reviewDecision",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const detail = await detailCmd.output();
    processed++;
    Deno.stdout.writeSync(
      new TextEncoder().encode(
        `\r  [${processed}/${searchResults.length}]`,
      ),
    );

    if (detail.code !== 0) {
      return { ...pr, reviewDecision: "" };
    }

    const data = JSON.parse(new TextDecoder().decode(detail.stdout));
    return { ...pr, reviewDecision: data.reviewDecision ?? "" };
  };

  const prs = await runWithConcurrency(searchResults, 10, fetchReviewStatus);

  prs.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  console.log("\n");
  console.log(`${"=".repeat(60)}`);
  console.log(`📝 YOUR OPEN PRs (${prs.length}):\n`);

  for (const pr of prs) {
    const status = pr.reviewDecision === "APPROVED"
      ? "✅ approved"
      : pr.reviewDecision === "CHANGES_REQUESTED"
      ? "🔄 changes requested"
      : pr.reviewDecision === "REVIEW_REQUIRED"
      ? "⏳ awaiting review"
      : "⚪ no reviews";
    const date = new Date(pr.createdAt).toLocaleDateString("sv-SE");
    console.log(`  ${status} ${pr.repository.nameWithOwner}#${pr.number}`);
    console.log(`    ${pr.title}`);
    console.log(`    ${date} | ${pr.url}`);
    console.log();
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`\nTotal: ${prs.length} open PRs`);
};

export const listBotPrsNeedingReview = async (
  options: BotPrsOptions = {},
): Promise<void> => {
  const user = await getGitHubUser();
  const org = options.org ?? Deno.env.get("LGTM_ORG");

  console.log(
    `\nFetching PRs you've reviewed${org ? ` in ${org}` : ""}...\n`,
  );

  const args = [
    "search",
    "prs",
    "--reviewed-by",
    user,
    "--state",
    "open",
    "--json",
    "repository,number,title,url,author",
    "--limit",
    "100",
  ];

  const command = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    console.error(`Failed to search PRs: ${error}`);
    return;
  }

  type SearchResult = {
    repository: { nameWithOwner: string };
    number: number;
    title: string;
    url: string;
    author: { login: string; type: string };
  };

  let results: SearchResult[] = JSON.parse(new TextDecoder().decode(stdout));

  if (org) {
    results = results.filter((pr) =>
      pr.repository.nameWithOwner.toLowerCase().startsWith(
        org.toLowerCase() + "/",
      )
    );
  }

  const botPrs = results.filter(
    (pr) =>
      pr.author.type === "Bot" ||
      BOT_AUTHORS.some((bot) => pr.author.login.toLowerCase().includes(bot)),
  );

  if (botPrs.length === 0) {
    console.log("No open bot PRs you've reviewed.");
    return;
  }

  console.log(`Found ${botPrs.length} bot PRs, checking approval status...`);

  type PrWithReviews = {
    repo: string;
    number: number;
    url: string;
    onlyUserApproved: boolean;
  };

  let processed = 0;

  const checkPrReviews = async (
    pr: SearchResult,
  ): Promise<PrWithReviews | null> => {
    const detailCmd = new Deno.Command("gh", {
      args: [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        pr.repository.nameWithOwner,
        "--json",
        "reviews",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const detail = await detailCmd.output();
    processed++;
    Deno.stdout.writeSync(
      new TextEncoder().encode(`\r  [${processed}/${botPrs.length}]`),
    );

    if (detail.code !== 0) return null;

    type ReviewDetail = {
      reviews: Array<{ author: { login: string }; state: string }>;
    };

    const reviewData: ReviewDetail = JSON.parse(
      new TextDecoder().decode(detail.stdout),
    );

    const approvals = reviewData.reviews.filter((r) => r.state === "APPROVED");
    const userApproved = approvals.some(
      (r) => r.author.login.toLowerCase() === user.toLowerCase(),
    );
    const onlyUserApproved = userApproved && approvals.length === 1;

    return {
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      url: pr.url,
      onlyUserApproved,
    };
  };

  const reviewResults = await runWithConcurrency(botPrs, 10, checkPrReviews);
  const prsNeedingReview = reviewResults.filter(
    (p): p is PrWithReviews => p !== null && p.onlyUserApproved,
  );

  console.log("\n");

  if (prsNeedingReview.length === 0) {
    console.log("No bot PRs need another review.");
    return;
  }

  console.log("Bot PRs where only I have approved (needs +1):");
  for (const pr of prsNeedingReview) {
    console.log(`- ${pr.url}`);
  }
  console.log(`\nTotal: ${prsNeedingReview.length} PRs`);
};
