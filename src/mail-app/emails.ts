import { parsePrFromSubject } from "../shared/parse-subject.ts";
import type { MailAppEmail } from "../shared/types.ts";

export type { MailAppEmail as GitHubEmail };

const runAppleScript = async (script: string): Promise<string> => {
  const cmd = new Deno.Command("osascript", {
    args: ["-e", script],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`AppleScript error: ${error}`);
  }

  return new TextDecoder().decode(stdout).trim();
};

const escapeForAppleScript = (str: string): string =>
  str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const findGitHubMailboxes = async (): Promise<
  Array<{ account: string; mailbox: string }>
> => {
  const script = `
    set output to ""
    tell application "Mail"
      repeat with acct in accounts
        set acctName to name of acct
        repeat with mbox in mailboxes of acct
          set mboxName to name of mbox
          if mboxName is "github" or mboxName is "GitHub" then
            set output to output & acctName & "|||" & mboxName & "
"
            repeat with subMbox in mailboxes of mbox
              set subName to name of subMbox
              set output to output & acctName & "|||" & mboxName & "/" & subName & "
"
            end repeat
          end if
        end repeat
      end repeat
    end tell
    return output
  `;

  const result = await runAppleScript(script);

  if (!result.trim()) {
    return [];
  }

  return result
    .split("\n")
    .filter((line) => line.includes("|||"))
    .map((line) => {
      const [account, mailbox] = line.split("|||");
      return { account: account.trim(), mailbox: mailbox.trim() };
    });
};

export const fetchGitHubEmails = async (
  folderName?: string,
): Promise<MailAppEmail[]> => {
  const mailboxes = await findGitHubMailboxes();

  if (mailboxes.length === 0) {
    console.log(
      "No 'github' mailbox found in Mail.app. Make sure you have a folder named 'github'.",
    );
    return [];
  }

  const targetMailboxes = folderName
    ? mailboxes.filter((m) =>
      m.mailbox.toLowerCase() === `github/${folderName}`.toLowerCase() ||
      m.mailbox.toLowerCase() === folderName.toLowerCase()
    )
    : mailboxes.filter((m) => m.mailbox.includes("/"));

  if (targetMailboxes.length === 0) {
    if (folderName) {
      console.log(`No folder named '${folderName}' found under github/`);
    } else {
      const parentOnly = mailboxes.filter((m) => !m.mailbox.includes("/"));
      if (parentOnly.length > 0) {
        console.log(
          "Found 'github' folder but no subfolders. Scanning main github folder...",
        );
        targetMailboxes.push(...parentOnly);
      }
    }
  }

  if (targetMailboxes.length === 0) {
    return [];
  }

  const allEmails: MailAppEmail[] = [];

  for (const { account, mailbox } of targetMailboxes) {
    console.log(`Scanning mailbox: ${mailbox} (${account})`);

    const script = `
      set output to ""
      tell application "Mail"
        set acct to account "${escapeForAppleScript(account)}"
        set mbox to mailbox "${escapeForAppleScript(mailbox)}" of acct
        set msgs to messages of mbox whose sender contains "github.com"
        repeat with msg in msgs
          set msgId to id of msg
          set msgMessageId to message id of msg
          set msgSubject to subject of msg
          set msgDate to date received of msg
          set y to year of msgDate
          set m to (month of msgDate as integer)
          set d to day of msgDate
          set h to hours of msgDate
          set min to minutes of msgDate
          set isoDate to (y as string) & "-" & (text -2 thru -1 of ("0" & m)) & "-" & (text -2 thru -1 of ("0" & d)) & "T" & (text -2 thru -1 of ("0" & h)) & ":" & (text -2 thru -1 of ("0" & min)) & ":00"
          set output to output & msgId & "|||" & msgMessageId & "|||" & msgSubject & "|||" & isoDate & "
"
        end repeat
      end tell
      return output
    `;

    try {
      const result = await runAppleScript(script);

      if (!result.trim()) {
        continue;
      }

      const lines = result.split("\n").filter((line) => line.includes("|||"));

      for (const line of lines) {
        const parts = line.split("|||");
        if (parts.length >= 4) {
          const [id, messageId, subject, dateReceived] = parts;
          const { repo, prNumber } = parsePrFromSubject(subject);

          allEmails.push({
            id: id.trim(),
            messageId: messageId.trim(),
            subject: subject.trim(),
            receivedDateTime: dateReceived.trim(),
            repo,
            prNumber,
            mailbox,
            account,
          });
        }
      }
    } catch (e) {
      console.log(`Error scanning ${mailbox}: ${e}`);
    }
  }

  return allEmails;
};

export const moveToTrash = async (
  account: string,
  mailbox: string,
  messageId: string,
): Promise<void> => {
  const script = `
    tell application "Mail"
      set acct to account "${escapeForAppleScript(account)}"
      set mbox to mailbox "${escapeForAppleScript(mailbox)}" of acct
      set msgs to (messages of mbox whose message id is "${
    escapeForAppleScript(messageId)
  }")
      repeat with msg in msgs
        delete msg
      end repeat
    end tell
  `;

  await runAppleScript(script);
};

type BatchMoveResult = {
  succeeded: number;
  failed: number;
  errors: string[];
};

export const batchMoveToTrash = async (
  emails: Array<{ account: string; mailbox: string; id: string }>,
): Promise<BatchMoveResult> => {
  const byMailbox = new Map<string, typeof emails>();

  for (const email of emails) {
    const key = `${email.account}|||${email.mailbox}`;
    const existing = byMailbox.get(key) ?? [];
    existing.push(email);
    byMailbox.set(key, existing);
  }

  const total = emails.length;
  const result: BatchMoveResult = { succeeded: 0, failed: 0, errors: [] };

  for (const [key, mailboxEmails] of byMailbox.entries()) {
    const [account, mailbox] = key.split("|||");

    const ids = mailboxEmails.map((e) => e.id).join(", ");

    const script = `
      set deletedCount to 0
      tell application "Mail"
        set acct to account "${escapeForAppleScript(account)}"
        set mbox to mailbox "${escapeForAppleScript(mailbox)}" of acct
        set trashMbox to missing value
        try
          set trashMbox to mailbox "Deleted Items" of acct
        end try
        if trashMbox is missing value then
          try
            set trashMbox to mailbox "Trash" of acct
          end try
        end if
        set targetIds to {${ids}}
        repeat with targetId in targetIds
          try
            set msg to (first message of mbox whose id is targetId)
            if trashMbox is not missing value then
              move msg to trashMbox
            else
              delete msg
            end if
            set deletedCount to deletedCount + 1
          end try
        end repeat
      end tell
      return deletedCount
    `;

    try {
      const countStr = await runAppleScript(script);
      const deletedCount = parseInt(countStr, 10) || 0;
      result.succeeded += deletedCount;
      const expectedCount = mailboxEmails.length;
      if (deletedCount < expectedCount) {
        result.failed += expectedCount - deletedCount;
        result.errors.push(
          `${mailbox}: expected ${expectedCount}, deleted ${deletedCount}`,
        );
      }
      console.log(`Moved ${result.succeeded}/${total} emails to trash`);
    } catch (e) {
      result.failed += mailboxEmails.length;
      result.errors.push(`${mailbox}: ${e}`);
      console.log(`Error moving emails from ${mailbox}: ${e}`);
    }
  }

  if (result.errors.length > 0) {
    console.log(
      `\nWarnings: ${result.errors.length} issues occurred during deletion`,
    );
  }

  return result;
};
