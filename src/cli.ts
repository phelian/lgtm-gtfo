import { parseArgs } from "@std/cli/parse-args";
import {
  type Backend,
  processEmails,
  type ProcessOptions,
} from "./processor.ts";
import { listPendingReviews } from "./github/pr.ts";

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
  --no-bot                  Exclude bot PRs (dependabot, es-robot) from --pending
  --graph                   Use Microsoft Graph API (requires OAuth)
  --ews                     Use Exchange Web Services (requires OAuth)
  --help                    Show this help message

Environment:
  LGTM_BACKEND              Backend: graph (default), ews, or mail-app
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
      "help",
      "graph",
      "ews",
    ],
    string: ["folder", "ci-days"],
    alias: {
      h: "help",
    },
  });

  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.pending) {
    await listPendingReviews({ excludeBots: parsed["no-bot"] });
    return;
  }

  const envBackend = Deno.env.get("LGTM_BACKEND") as Backend | undefined;
  const backend: Backend = parsed.graph
    ? "graph"
    : parsed.ews
    ? "ews"
    : envBackend ?? "graph";

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
