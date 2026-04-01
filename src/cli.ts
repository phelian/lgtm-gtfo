import { parseArgs } from "@std/cli/parse-args";
import {
  type Backend,
  processEmails,
  type ProcessOptions,
} from "./processor.ts";
import {
  listBotPrsNeedingReview,
  listMyPrs,
  listPendingReviews,
} from "./github/pr.ts";
import { batchMarkAsUnread, fetchGitHubEmails } from "./mail-app/emails.ts";

const getBotPatterns = (): string[] => {
  const envBots = Deno.env.get("LGTM_BOTS");
  if (envBots) {
    return envBots.split(",").map((b) => b.trim().toLowerCase());
  }
  return ["dependabot"];
};

type UnreadOptions = {
  folder?: string;
  excludeBots?: boolean;
};

const markGitHubEmailsUnread = async (
  options: UnreadOptions,
): Promise<void> => {
  console.log("\nFetching GitHub emails from Mail.app...\n");

  const emails = await fetchGitHubEmails(options.folder);

  if (emails.length === 0) {
    console.log("No GitHub emails found.");
    return;
  }

  const botPatterns = getBotPatterns();
  const filtered = options.excludeBots
    ? emails.filter((e) => {
      const mailboxLower = e.mailbox?.toLowerCase() ?? "";
      const subjectLower = e.subject.toLowerCase();
      return !botPatterns.some(
        (bot) => mailboxLower.includes(bot) || subjectLower.includes(bot),
      );
    })
    : emails;

  if (filtered.length === 0) {
    console.log("No emails to mark (all filtered by --no-bot).");
    return;
  }

  console.log(`Found ${filtered.length} emails to mark as unread.`);

  const toMark = filtered.map((e) => ({
    account: e.account!,
    mailbox: e.mailbox!,
    id: e.id,
  }));

  await batchMarkAsUnread(toMark);
  console.log("\nDone.");
};

const printHelp = () => {
  console.log(`
lgtm-gtfo

Looks Good To Me? Get The F*** Out (of my inbox).
Clean up GitHub notification emails for merged PRs where you weren't mentioned.

Usage:
  deno task lgtm [options]  # Dry run
  deno task gtfo            # Actually delete (--confirm)

Options:
  --confirm                 Actually delete emails (default: dry-run)
  --folder <name>           Only scan specific github subfolder
  --skip-mentions           Delete even if you were @mentioned
  --skip-review-requests    Delete even if you were requested as reviewer
  --ci-days <days>          Delete CI/workflow emails older than N days
  --pending                 List PRs waiting for your review (no email deletion)
  --no-bot                  Exclude bot PRs (dependabot) from --pending/--unread
  --my                      Include your own PRs in --pending
  --mine                    List your open PRs with status (oldest last)
  --nudge                   List bot PRs you reviewed that need another approval (Slack format)
  --unread                  Mark all GitHub emails as unread (mail-app only)
  --org <name>              Filter PRs by organization (or set LGTM_ORG)
  --graph                   Use Microsoft Graph API (requires OAuth)
  --ews                     Use Exchange Web Services (requires OAuth)
  --help                    Show this help message

Files:
  .exclude                  One pattern per line to hide PRs from --pending
                            (matches against url, repo, title, author; # comments)

Environment:
  LGTM_BACKEND              Backend: graph (default), ews, or mail-app
  LGTM_ORG                  Filter PRs by organization
  GITHUB_HANDLE             Your GitHub username (for mention/reviewer checks)

Backends:
  graph      Microsoft Graph API (default, requires OAuth)
  ews        Exchange Web Services (requires OAuth)
  mail-app   macOS Mail.app via AppleScript (workaround for strict orgs)

Examples:
  deno task lgtm                         # Dry run - see what would be deleted
  deno task gtfo                         # Actually move emails to trash
  deno task lgtm --folder dependabot     # Only scan github/dependabot folder
`);
};

export const run = async (args: string[]): Promise<void> => {
  const parsed = parseArgs(args, {
    boolean: [
      "confirm",
      "skip-mentions",
      "skip-review-requests",
      "pending",
      "no-bot",
      "my",
      "mine",
      "nudge",
      "unread",
      "help",
      "graph",
      "ews",
    ],
    string: ["folder", "ci-days", "org"],
    alias: {
      h: "help",
    },
  });

  if (parsed.help) {
    printHelp();
    return;
  }

  const envBackend = Deno.env.get("LGTM_BACKEND") as Backend | undefined;
  const backend: Backend = parsed.graph
    ? "graph"
    : parsed.ews
    ? "ews"
    : envBackend ?? "graph";

  if (parsed.mine) {
    await listMyPrs({ org: parsed.org });
    return;
  }

  if (parsed.nudge) {
    await listBotPrsNeedingReview({ org: parsed.org });
    return;
  }

  if (parsed.unread) {
    await markGitHubEmailsUnread({
      folder: parsed.folder,
      excludeBots: parsed["no-bot"],
    });
    return;
  }

  if (parsed.pending) {
    await listPendingReviews({
      excludeBots: parsed["no-bot"],
      includeMine: parsed["my"],
      backend,
      folder: parsed.folder,
      org: parsed.org,
    });
    return;
  }

  const ciDays = parsed["ci-days"]
    ? parseInt(parsed["ci-days"], 10)
    : undefined;

  const options: ProcessOptions = {
    folder: parsed.folder,
    skipMentions: parsed["skip-mentions"] ?? false,
    skipReviewRequests: parsed["skip-review-requests"] ?? false,
    ciDays,
    confirm: parsed.confirm ?? false,
    backend,
  };

  await processEmails(options);
};
