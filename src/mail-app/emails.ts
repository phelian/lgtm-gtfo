import { parsePrFromSubject } from "../shared/parse-subject.ts";
import type { MailAppEmail } from "../shared/types.ts";

export type { MailAppEmail as GitHubEmail };

const runAppleScript = async (
  script: string,
  timeoutMs?: number,
): Promise<string> => {
  const controller = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;

  const cmd = new Deno.Command("osascript", {
    args: ["-e", script],
    stdout: "piped",
    stderr: "piped",
    signal: controller.signal,
  });

  try {
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(`AppleScript error: ${new TextDecoder().decode(stderr)}`);
    }
    return new TextDecoder().decode(stdout).trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
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

const fetchInboxEmails = async (): Promise<MailAppEmail[]> => {
  console.log("Scanning mailbox: Inbox");

  const script = `
    set output to ""
    tell application "Mail"
      set msgs to messages of inbox whose sender contains "github.com"
      repeat with msg in msgs
        try
          set msgId to id of msg
          set msgMessageId to message id of msg
          set msgSubject to subject of msg
          set msgMbox to name of mailbox of msg
          set msgAcct to name of account of mailbox of msg
          set msgDate to date received of msg
          set y to year of msgDate
          set m to (month of msgDate as integer)
          set d to day of msgDate
          set h to hours of msgDate
          set min to minutes of msgDate
          set isoDate to (y as string) & "-" & (text -2 thru -1 of ("0" & m)) & "-" & (text -2 thru -1 of ("0" & d)) & "T" & (text -2 thru -1 of ("0" & h)) & ":" & (text -2 thru -1 of ("0" & min)) & ":00"
          set output to output & msgId & "|||" & msgMessageId & "|||" & msgSubject & "|||" & isoDate & "|||" & msgAcct & "|||" & msgMbox & "
"
        end try
      end repeat
    end tell
    return output
  `;

  try {
    const result = await runAppleScript(script);
    if (!result.trim()) return [];

    const emails: MailAppEmail[] = [];
    const lines = result.split("\n").filter((line) => line.includes("|||"));

    for (const line of lines) {
      const parts = line.split("|||");
      if (parts.length >= 6) {
        const [id, messageId, subject, dateReceived, account, mailbox] = parts;
        const { repo, prNumber } = parsePrFromSubject(subject);

        emails.push({
          id: id.trim(),
          messageId: messageId.trim(),
          subject: subject.trim(),
          receivedDateTime: dateReceived.trim(),
          repo,
          prNumber,
          mailbox: mailbox.trim(),
          account: account.trim(),
        });
      }
    }

    return emails;
  } catch (e) {
    console.log(`Error scanning inbox: ${e}`);
    return [];
  }
};

const fetchMailboxEmails = async (
  account: string,
  mailbox: string,
): Promise<MailAppEmail[]> => {
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
    if (!result.trim()) return [];

    const emails: MailAppEmail[] = [];
    const lines = result.split("\n").filter((line) => line.includes("|||"));

    for (const line of lines) {
      const parts = line.split("|||");
      if (parts.length >= 4) {
        const [id, messageId, subject, dateReceived] = parts;
        const { repo, prNumber } = parsePrFromSubject(subject);

        emails.push({
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

    return emails;
  } catch (e) {
    console.log(`Error scanning ${mailbox}: ${e}`);
    return [];
  }
};

export const fetchGitHubEmails = async (
  folderName?: string,
): Promise<MailAppEmail[]> => {
  const allEmails: MailAppEmail[] = [];
  const scanInbox = folderName === undefined ||
    folderName?.toLowerCase() === "inbox";
  const scanGithub = folderName === undefined ||
    (folderName !== undefined && folderName.toLowerCase() !== "inbox");

  if (scanGithub) {
    const mailboxes = await findGitHubMailboxes();

    if (mailboxes.length === 0 && folderName) {
      console.log(
        "No 'github' mailbox found in Mail.app.",
      );
    }

    const targetMailboxes = folderName
      ? mailboxes.filter((m) =>
        m.mailbox.toLowerCase() === `github/${folderName}`.toLowerCase() ||
        m.mailbox.toLowerCase() === folderName.toLowerCase()
      )
      : mailboxes.filter((m) => m.mailbox.includes("/"));

    if (targetMailboxes.length === 0 && !folderName) {
      const parentOnly = mailboxes.filter((m) => !m.mailbox.includes("/"));
      if (parentOnly.length > 0) {
        console.log(
          "Found 'github' folder but no subfolders. Scanning main github folder...",
        );
        targetMailboxes.push(...parentOnly);
      }
    } else if (targetMailboxes.length === 0 && folderName) {
      console.log(`No folder named '${folderName}' found under github/`);
    }

    for (const { account, mailbox } of targetMailboxes) {
      const emails = await fetchMailboxEmails(account, mailbox);
      allEmails.push(...emails);
    }
  }

  if (scanInbox) {
    const emails = await fetchInboxEmails();
    allEmails.push(...emails);
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

export const batchMarkAsUnread = async (
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
      set markedCount to 0
      tell application "Mail"
        set acct to account "${escapeForAppleScript(account)}"
        set mbox to mailbox "${escapeForAppleScript(mailbox)}" of acct
        set targetIds to {${ids}}
        repeat with targetId in targetIds
          try
            set candidates to (messages of mbox whose id is targetId)
            if (count of candidates) > 0 then
              set msg to item 1 of candidates
              set read status of msg to false
              set markedCount to markedCount + 1
            end if
          on error
          end try
        end repeat
      end tell
      return markedCount
    `;

    try {
      const countStr = await runAppleScript(script);
      const markedCount = parseInt(countStr, 10) || 0;
      result.succeeded += markedCount;
      const expectedCount = mailboxEmails.length;
      if (markedCount < expectedCount) {
        result.failed += expectedCount - markedCount;
        result.errors.push(
          `${mailbox}: expected ${expectedCount}, marked ${markedCount}`,
        );
      }
      console.log(`Marked ${result.succeeded}/${total} emails as unread`);
    } catch (e) {
      result.failed += mailboxEmails.length;
      result.errors.push(`${mailbox}: ${e}`);
      console.log(`Error marking emails in ${mailbox}: ${e}`);
    }
  }

  if (result.errors.length > 0) {
    console.log(
      `\nWarnings: ${result.errors.length} issues occurred`,
    );
  }

  return result;
};

const deleteCanceledMeetings = async (
  confirm: boolean,
): Promise<number> => {
  const script = `
    set output to ""
    tell application "Mail"
      set msgs to messages of inbox whose subject begins with "Canceled:" or subject begins with "Cancelled:"
      repeat with msg in msgs
        set msgId to id of msg
        set msgSubject to subject of msg
        set output to output & msgId & "|||" & msgSubject & "
"
      end repeat
    end tell
    return output
  `;

  const result = await runAppleScript(script);
  if (!result.trim()) return 0;

  const lines = result.split("\n").filter((line) => line.includes("|||"));
  if (lines.length === 0) return 0;

  console.log(`  Canceled meetings: ${lines.length} emails`);
  for (const line of lines) {
    const subject = line.split("|||")[1]?.trim() ?? "";
    console.log(`    ${subject}`);
  }

  if (!confirm) return lines.length;

  const ids = lines.map((line) => line.split("|||")[0].trim()).join(", ");
  const deleteScript = `
    set deletedCount to 0
    tell application "Mail"
      set targetIds to {${ids}}
      repeat with targetId in targetIds
        try
          set candidates to (messages of inbox whose id is targetId)
          if (count of candidates) > 0 then
            set msg to item 1 of candidates
            delete msg
            set deletedCount to deletedCount + 1
          end if
        on error
        end try
      end repeat
    end tell
    return deletedCount
  `;

  const countStr = await runAppleScript(deleteScript);
  return parseInt(countStr, 10) || 0;
};

const decodeQuotedPrintable = (body: string): string =>
  body
    .replace(/=\r?\n/g, "")
    .replace(
      /=([0-9A-Fa-f]{2})/g,
      (_, h) => String.fromCharCode(parseInt(h, 16)),
    );

const extractCalendar = (src: string): string | null => {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /content-type:\s*text\/calendar/i.test(l)
  );
  if (start === -1) return null;

  let encoding = "";
  let i = start + 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    const enc = lines[i].match(/content-transfer-encoding:\s*(\S+)/i);
    if (enc) encoding = enc[1].toLowerCase();
  }

  const bodyLines: string[] = [];
  for (i++; i < lines.length && !lines[i].startsWith("--"); i++) {
    bodyLines.push(lines[i]);
  }

  const raw = bodyLines.join("\n");
  if (encoding === "base64") {
    try {
      return atob(raw.replace(/\s+/g, ""));
    } catch {
      return null;
    }
  }
  if (encoding === "quoted-printable") return decodeQuotedPrintable(raw);
  return raw;
};

const icsDay = (vevent: string, kw: string): number | null => {
  const match = vevent.match(new RegExp(`^${kw}[^:\\r\\n]*:\\s*(\\d{8})`, "m"));
  return match ? parseInt(match[1], 10) : null;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const calendarDay = (src: string): number | null => {
  const cal = extractCalendar(src);
  if (cal === null) return null;

  const begin = cal.indexOf("BEGIN:VEVENT");
  if (begin === -1) return null;
  const end = cal.indexOf("END:VEVENT", begin);
  const vevent = (end === -1 ? cal.slice(begin) : cal.slice(begin, end))
    .replace(/\r?\n[ \t]/g, "");

  if (/^RRULE[:;]/m.test(vevent)) return Infinity;

  return icsDay(vevent, "DTEND") ?? icsDay(vevent, "DTSTART");
};

const bodyMeetingDay = (src: string): number | null => {
  for (const w of src.matchAll(/When:\s*([^\r\n]{0,160})/gi)) {
    const line = w[1].replace(/<[^>]+>/g, " ").replace(/&[a-z]+;?/gi, " ");
    const dates = [...line.matchAll(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/g)];
    const last = dates.at(-1);
    if (!last) continue;
    const month = MONTHS[last[2].slice(0, 3).toLowerCase()];
    if (!month) continue;
    return parseInt(last[3]) * 10000 + month * 100 + parseInt(last[1]);
  }
  return null;
};

const pastMeetingDay = (src: string, todayInt: number): boolean => {
  const day = calendarDay(src) ?? bodyMeetingDay(src);
  return day !== null && day < todayInt;
};

const deletePastMeetings = async (
  confirm: boolean,
): Promise<number> => {
  const script = `
    set output to ""
    tell application "Mail"
      set msgs to messages of inbox
      repeat with msg in msgs
        try
          set src to source of msg
          if (src contains "text/calendar") or (src contains "teams.microsoft.com") then
            set subj to subject of msg
            if not (subj begins with "Canceled:" or subj begins with "Cancelled:") then
              set output to output & "@@@MSG@@@" & (id of msg) & "|||" & subj & "@@@SRC@@@" & src & "@@@END@@@"
            end if
          end if
        end try
      end repeat
    end tell
    return output
  `;

  console.log("  Scanning for past meetings...");
  const result = await runAppleScript(script, 60000).catch(() => {
    console.log(
      "  Skipped past-meeting scan (Mail timed out — try Mailbox > Rebuild).",
    );
    return "";
  });
  if (!result.trim()) return 0;

  const now = new Date();
  const todayInt = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 +
    now.getDate();

  const past = result
    .split("@@@MSG@@@")
    .slice(1)
    .map((rec) => {
      const srcIdx = rec.indexOf("@@@SRC@@@");
      const endIdx = rec.indexOf("@@@END@@@");
      const [id, subject] = rec.slice(0, srcIdx).split("|||");
      const src = rec.slice(
        srcIdx + "@@@SRC@@@".length,
        endIdx === -1 ? undefined : endIdx,
      );
      return { id: id?.trim() ?? "", subject: subject?.trim() ?? "", src };
    })
    .filter(({ id, src }) => id && pastMeetingDay(src, todayInt));

  if (past.length === 0) return 0;

  console.log(`  Past meetings: ${past.length} emails`);
  for (const { subject } of past) {
    console.log(`    ${subject}`);
  }

  if (!confirm) return past.length;

  const ids = past.map(({ id }) => id).join(", ");
  const deleteScript = `
    set deletedCount to 0
    tell application "Mail"
      set targetIds to {${ids}}
      repeat with targetId in targetIds
        try
          set candidates to (messages of inbox whose id is targetId)
          if (count of candidates) > 0 then
            set msg to item 1 of candidates
            delete msg
            set deletedCount to deletedCount + 1
          end if
        on error
        end try
      end repeat
    end tell
    return deletedCount
  `;

  const countStr = await runAppleScript(deleteScript);
  return parseInt(countStr, 10) || 0;
};

const moveEmailsToFolder = async (
  account: string,
  parent: string,
  child: string | null,
  ids: number[],
): Promise<number> => {
  const targetExpr = child === null
    ? `mailbox "${escapeForAppleScript(parent)}" of acct`
    : `mailbox "${escapeForAppleScript(child)}" of mailbox "${
      escapeForAppleScript(parent)
    }" of acct`;
  const script = `
    set movedCount to 0
    tell application "Mail"
      set acct to account "${escapeForAppleScript(account)}"
      set targetMbox to ${targetExpr}
      set targetIds to {${ids.join(", ")}}
      repeat with targetId in targetIds
        try
          set candidates to (messages of inbox whose id is targetId)
          if (count of candidates) > 0 then
            set msg to item 1 of candidates
            move msg to targetMbox
            set movedCount to movedCount + 1
          end if
        on error
        end try
      end repeat
    end tell
    return movedCount
  `;
  const result = await runAppleScript(script);
  return parseInt(result, 10) || 0;
};

type OrganizeTarget = {
  account: string;
  parentName: string;
  childName: string | null;
  emails: MailAppEmail[];
  exists: boolean;
};

const classifyTarget = (
  subject: string,
  repo: string | null,
): string | null | undefined => {
  if (subject.startsWith("Request")) return "requests";
  if (subject.startsWith("[GitHub]")) return null;
  if (repo) return repo.includes("/") ? repo.split("/").pop()! : repo;
  return undefined;
};

const targetLabel = (t: OrganizeTarget): string =>
  t.childName === null ? t.parentName : `${t.parentName}/${t.childName}`;

export const organizeInboxEmails = async (
  confirm: boolean,
): Promise<void> => {
  console.log("\nScanning inbox...\n");

  const inboxEmails = await fetchInboxEmails();
  const mailboxes = await findGitHubMailboxes();

  const githubParents = new Map<string, string>();
  const existingFolders = new Set<string>();

  for (const { account, mailbox } of mailboxes) {
    if (!mailbox.includes("/")) {
      githubParents.set(account, mailbox);
    } else {
      const afterSlash = mailbox.slice(mailbox.indexOf("/") + 1);
      if (!afterSlash.includes("/")) {
        existingFolders.add(`${account}|||${afterSlash.toLowerCase()}`);
      }
    }
  }

  const targets = new Map<string, OrganizeTarget>();
  const skipped: MailAppEmail[] = [];

  for (const email of inboxEmails) {
    const childName = classifyTarget(email.subject, email.repo);
    if (childName === undefined) continue;

    const parentName = githubParents.get(email.account);
    if (!parentName) {
      skipped.push(email);
      continue;
    }

    const childKey = childName === null ? "" : childName.toLowerCase();
    const key = `${email.account}|||${childKey}`;

    if (!targets.has(key)) {
      const exists = childName === null || existingFolders.has(key);
      targets.set(key, {
        account: email.account,
        parentName,
        childName,
        emails: [],
        exists,
      });
    }
    targets.get(key)!.emails.push(email);
  }

  const sorted = [...targets.values()].sort((a, b) =>
    (a.childName ?? "").localeCompare(b.childName ?? "")
  );
  const ready = sorted.filter((t) => t.exists);
  const missing = sorted.filter((t) => !t.exists);
  const readyCount = ready.reduce((sum, t) => sum + t.emails.length, 0);

  for (const target of sorted) {
    const tag = target.exists ? "" : " [MISSING]";
    console.log(
      `  ${targetLabel(target)}${tag}: ${target.emails.length} emails`,
    );
  }

  if (missing.length > 0) {
    console.log(
      `\nCreate these folders manually in Mail.app (AppleScript can't create Exchange subfolders):`,
    );
    for (const t of missing) {
      console.log(`  ${targetLabel(t)}`);
    }
  }

  if (skipped.length > 0) {
    console.log(
      `\n[SKIPPED] ${skipped.length} email(s) — no 'github' parent mailbox in their account:`,
    );
    for (const e of skipped) {
      console.log(`  (${e.account}) ${e.subject}`);
    }
  }

  let moved = 0;
  if (readyCount > 0) {
    console.log(`\n${readyCount} email(s) ready to move.`);
    if (confirm) {
      for (const target of ready) {
        const ids = target.emails.map((e) => parseInt(e.id, 10));
        moved += await moveEmailsToFolder(
          target.account,
          target.parentName,
          target.childName,
          ids,
        );
        console.log(`Moved ${moved}/${readyCount} emails`);
      }
    } else {
      console.log("Dry run - use --confirm to move emails.");
    }
  } else if (targets.size > 0) {
    console.log(
      "\nNo emails to move (all targets need folder creation first).",
    );
  }

  const canceledCount = await deleteCanceledMeetings(confirm);
  const pastCount = await deletePastMeetings(confirm);

  const nothing = readyCount === 0 && canceledCount === 0 && pastCount === 0;

  if (!confirm) {
    if (nothing) console.log("\nNothing to tidy.");
    return;
  }

  const parts = [
    moved > 0 ? `moved ${moved} emails` : null,
    canceledCount > 0 ? `deleted ${canceledCount} canceled meetings` : null,
    pastCount > 0 ? `deleted ${pastCount} past meetings` : null,
  ].filter(Boolean);

  console.log(
    parts.length > 0 ? `\nDone! ${parts.join(", ")}.` : "\nNothing to tidy.",
  );
};

type BatchMoveInput = {
  account: string;
  mailbox: string;
  id: string;
  messageId?: string;
};

type BatchMoveResultWithSkipped = BatchMoveResult & { skipped: number };

export const batchMoveToTrash = async (
  emails: BatchMoveInput[],
): Promise<BatchMoveResultWithSkipped> => {
  const byMailbox = new Map<string, BatchMoveInput[]>();

  for (const email of emails) {
    const key = `${email.account}|||${email.mailbox}`;
    const existing = byMailbox.get(key) ?? [];
    existing.push(email);
    byMailbox.set(key, existing);
  }

  const total = emails.length;
  const result: BatchMoveResultWithSkipped = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (const [key, mailboxEmails] of byMailbox.entries()) {
    const [account, mailbox] = key.split("|||");

    const ids = mailboxEmails.map((e) => e.id).join(", ");
    const msgIdLiterals = mailboxEmails
      .map((e) => `"${escapeForAppleScript(e.messageId ?? "")}"`)
      .join(", ");

    const script = `
      set deletedCount to 0
      set skippedCount to 0
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
        set targetMsgIds to {${msgIdLiterals}}
        repeat with i from 1 to (count of targetIds)
          set targetId to item i of targetIds
          set targetMsgId to item i of targetMsgIds
          try
            set alreadyTrashed to false
            if trashMbox is not missing value and targetMsgId is not "" then
              try
                if (count of (messages of trashMbox whose message id is targetMsgId)) > 0 then
                  set alreadyTrashed to true
                end if
              end try
            end if
            if alreadyTrashed then
              set skippedCount to skippedCount + 1
            else
              if targetMsgId is not "" then
                set candidates to (messages of mbox whose message id is targetMsgId)
              else
                set candidates to (messages of mbox whose id is targetId)
              end if
              if (count of candidates) is 0 then
                set skippedCount to skippedCount + 1
              else
                set msg to item 1 of candidates
                set _validate to (source of msg)
                delete msg
                set deletedCount to deletedCount + 1
                delay 2
              end if
            end if
          on error
            set skippedCount to skippedCount + 1
          end try
        end repeat
      end tell
      return (deletedCount as string) & "|" & (skippedCount as string)
    `;

    try {
      const out = await runAppleScript(script);
      const [deletedStr, skippedStr] = out.split("|");
      const deletedCount = parseInt(deletedStr, 10) || 0;
      const skippedCount = parseInt(skippedStr, 10) || 0;
      result.succeeded += deletedCount;
      result.skipped += skippedCount;
      const expectedCount = mailboxEmails.length;
      const accounted = deletedCount + skippedCount;
      if (accounted < expectedCount) {
        result.failed += expectedCount - accounted;
        result.errors.push(
          `${mailbox}: expected ${expectedCount}, deleted ${deletedCount}, skipped ${skippedCount}`,
        );
      }
      console.log(
        `Moved ${result.succeeded}/${total} emails to trash` +
          (result.skipped > 0 ? ` (${result.skipped} already done)` : ""),
      );
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
