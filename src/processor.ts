import {
  batchMoveToTrash as graphBatchMove,
  fetchGitHubEmails as fetchGraphEmails,
} from "./ms-graph/emails.ts";
import {
  batchMoveToTrash as ewsBatchMove,
  fetchGitHubEmails as fetchEwsEmails,
} from "./ews/emails.ts";
import {
  batchMoveToTrash as mailAppBatchMove,
  fetchGitHubEmails as fetchMailAppEmails,
} from "./mail-app/emails.ts";
import { batchCheckPrs, type PrCheckResult } from "./github/pr.ts";
import type { UnifiedEmail } from "./shared/types.ts";

export type Backend = "mail-app" | "graph" | "ews";

export type ProcessOptions = {
  folder?: string;
  skipMentions: boolean;
  skipReviewRequests: boolean;
  ciDays?: number;
  confirm: boolean;
  backend: Backend;
};

type PrEmailToDelete = {
  email: UnifiedEmail;
  prResult: PrCheckResult;
  reason: string;
};

type CiEmailToDelete = {
  email: UnifiedEmail;
  reason: string;
};

const backendNames: Record<Backend, string> = {
  "mail-app": "Mail.app (AppleScript)",
  "graph": "Microsoft Graph API",
  "ews": "Exchange Web Services",
};

export const processEmails = async (options: ProcessOptions): Promise<void> => {
  const backendName = backendNames[options.backend];
  console.log(`Fetching GitHub emails via ${backendName}...\n`);

  const emails: UnifiedEmail[] = await (async () => {
    switch (options.backend) {
      case "mail-app": {
        const mailEmails = await fetchMailAppEmails(options.folder);
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
        return fetchGraphEmails(options.folder);
      case "ews":
        return fetchEwsEmails(options.folder);
    }
  })();

  if (emails.length === 0) {
    console.log("No GitHub emails found.");
    return;
  }

  console.log(`Found ${emails.length} GitHub emails.\n`);

  const prEmails = emails.filter((e) => e.repo && e.prNumber);
  const nonPrEmails = emails.filter((e) => !e.repo || !e.prNumber);

  const prToDelete: PrEmailToDelete[] = [];
  const ciToDelete: CiEmailToDelete[] = [];

  if (prEmails.length > 0) {
    console.log(`\nChecking PR status for ${prEmails.length} emails...`);

    const prResults = await batchCheckPrs(
      prEmails.map((e) => ({ repo: e.repo!, prNumber: e.prNumber! })),
    );

    for (const email of prEmails) {
      const key = `${email.repo}#${email.prNumber}`;
      const prResult = prResults.get(key);

      if (!prResult) continue;

      if (prResult.error) {
        continue;
      }

      if (prResult.state === "OPEN") {
        continue;
      }

      if (!options.skipMentions && prResult.wasMentioned) {
        continue;
      }

      if (!options.skipReviewRequests && prResult.wasRequestedReviewer) {
        continue;
      }

      prToDelete.push({
        email,
        prResult,
        reason:
          `${prResult.state.toLowerCase()} PR, not specifically mentioned`,
      });
    }
  }

  if (options.ciDays !== undefined && nonPrEmails.length > 0) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - options.ciDays);

    const ciPatterns = [
      /Run failed/i,
      /Run succeeded/i,
      /Run cancelled/i,
      /Run skipped/i,
      /workflow run/i,
    ];

    for (const email of nonPrEmails) {
      const isCiEmail = ciPatterns.some((p) => p.test(email.subject));
      if (!isCiEmail) continue;

      const emailDate = new Date(email.receivedDateTime);
      if (emailDate < cutoffDate) {
        ciToDelete.push({
          email,
          reason: `CI email older than ${options.ciDays} days`,
        });
      }
    }
  }

  const allToDelete = [
    ...prToDelete.map((d) => d.email),
    ...ciToDelete.map((d) => d.email),
  ];

  console.log(`\n${"=".repeat(60)}`);

  if (prToDelete.length > 0) {
    console.log(`\nPR emails to remove: ${prToDelete.length}\n`);
    for (const item of prToDelete.slice(0, 10)) {
      console.log(`  - ${item.email.subject}`);
      console.log(
        `    PR: ${item.email.repo}#${item.email.prNumber} (${item.prResult.state})`,
      );
    }
    if (prToDelete.length > 10) {
      console.log(`  ... and ${prToDelete.length - 10} more\n`);
    }
  }

  if (ciToDelete.length > 0) {
    console.log(`\nCI emails to remove: ${ciToDelete.length}\n`);
    for (const item of ciToDelete.slice(0, 10)) {
      console.log(`  - ${item.email.subject}`);
    }
    if (ciToDelete.length > 10) {
      console.log(`  ... and ${ciToDelete.length - 10} more\n`);
    }
  }

  if (allToDelete.length === 0) {
    console.log("No emails match deletion criteria.");
    return;
  }

  console.log(`\nTotal: ${allToDelete.length} emails to remove`);

  if (!options.confirm) {
    console.log(`${"=".repeat(60)}`);
    console.log(
      `\nDry run complete. ${allToDelete.length} emails would be moved to trash.`,
    );
    console.log("Run with --confirm to actually delete these emails.\n");
    return;
  }

  console.log(`\nMoving ${allToDelete.length} emails to trash...`);

  switch (options.backend) {
    case "mail-app":
      await mailAppBatchMove(
        allToDelete.map((e) => ({
          account: e.account!,
          mailbox: e.mailbox!,
          id: e.id,
        })),
      );
      break;
    case "graph":
      await graphBatchMove(allToDelete.map((e) => e.id));
      break;
    case "ews":
      await ewsBatchMove(
        allToDelete.map((e) => ({
          id: e.id,
          changeKey: e.changeKey!,
        })),
      );
      break;
  }

  console.log(`\nDone! Moved ${allToDelete.length} emails to trash.`);
};
