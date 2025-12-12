import { getAccessToken } from "./auth.ts";
import { parsePrFromSubject } from "../shared/parse-subject.ts";
import type { GraphEmail } from "../shared/types.ts";

export type { GraphEmail as GitHubEmail };

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

type MailFolder = {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
};

type Message = {
  id: string;
  subject: string;
  from?: {
    emailAddress: {
      address: string;
      name: string;
    };
  };
  receivedDateTime: string;
  webLink: string;
};

type GraphResponse<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

const graphFetch = async <T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> => {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Graph API error: ${response.status} ${error}`);
  }

  return response.json();
};

const findGitHubFolders = async (): Promise<MailFolder[]> => {
  const allFolders: MailFolder[] = [];

  const topLevel = await graphFetch<GraphResponse<MailFolder>>(
    "/me/mailFolders?$top=100",
  );

  const githubParent = topLevel.value.find(
    (f) => f.displayName.toLowerCase() === "github",
  );

  if (!githubParent) {
    console.log("No 'github' folder found in mailbox.");
    return [];
  }

  if (githubParent.childFolderCount > 0) {
    const children = await graphFetch<GraphResponse<MailFolder>>(
      `/me/mailFolders/${githubParent.id}/childFolders?$top=100`,
    );
    allFolders.push(...children.value);
  } else {
    allFolders.push(githubParent);
  }

  return allFolders;
};

export const fetchGitHubEmails = async (
  folderName?: string,
): Promise<GraphEmail[]> => {
  const folders = await findGitHubFolders();

  const targetFolders = folderName
    ? folders.filter((f) =>
      f.displayName.toLowerCase() === folderName.toLowerCase()
    )
    : folders;

  if (targetFolders.length === 0) {
    console.log(
      folderName
        ? `No folder named '${folderName}' found under github/`
        : "No github subfolders found.",
    );
    return [];
  }

  const emails: GraphEmail[] = [];

  const fetchPage = async (endpoint: string): Promise<void> => {
    const response = await graphFetch<GraphResponse<Message>>(endpoint);

    for (const msg of response.value) {
      const { repo, prNumber } = parsePrFromSubject(msg.subject);
      emails.push({
        id: msg.id,
        subject: msg.subject,
        receivedDateTime: msg.receivedDateTime,
        repo,
        prNumber,
        webLink: msg.webLink,
      });
    }

    const next = response["@odata.nextLink"]?.replace(GRAPH_BASE, "");
    if (next) {
      await fetchPage(next);
    }
  };

  for (const folder of targetFolders) {
    console.log(`Scanning folder: github/${folder.displayName}`);
    const initialEndpoint =
      `/me/mailFolders/${folder.id}/messages?$top=100&$select=id,subject,from,receivedDateTime,webLink&$filter=from/emailAddress/address eq 'notifications@github.com'`;
    await fetchPage(initialEndpoint);
  }

  return emails;
};

export const moveToTrash = async (messageId: string): Promise<void> => {
  await graphFetch(`/me/messages/${messageId}/move`, {
    method: "POST",
    body: JSON.stringify({
      destinationId: "deleteditems",
    }),
  });
};

export const batchMoveToTrash = async (messageIds: string[]): Promise<void> => {
  const batchSize = 20;
  const batches = Array.from(
    { length: Math.ceil(messageIds.length / batchSize) },
    (_, i) => messageIds.slice(i * batchSize, (i + 1) * batchSize),
  );

  const processBatch = async (
    batch: string[],
    batchIndex: number,
  ): Promise<void> => {
    const requests = batch.map((id, idx) => ({
      id: String(idx + 1),
      method: "POST",
      url: `/me/messages/${id}/move`,
      headers: { "Content-Type": "application/json" },
      body: { destinationId: "deleteditems" },
    }));

    const token = await getAccessToken();
    const response = await fetch(`${GRAPH_BASE}/$batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Batch move failed: ${error}`);
    }

    const processed = Math.min((batchIndex + 1) * batchSize, messageIds.length);
    console.log(`Moved ${processed}/${messageIds.length} emails to trash`);
  };

  for (const [index, batch] of batches.entries()) {
    await processBatch(batch, index);
  }
};
