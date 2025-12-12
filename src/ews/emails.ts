import { getEwsAccessToken } from "./auth.ts";
import { parsePrFromSubject } from "../shared/parse-subject.ts";
import { Document, DOMParser, Element } from "deno-dom";
import type { EwsEmail } from "../shared/types.ts";

export type { EwsEmail as GitHubEmail };

const EWS_URL = "https://outlook.office365.com/EWS/Exchange.asmx";

type EwsFolder = {
  id: string;
  changeKey: string;
  displayName: string;
};

const soapEnvelope = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
  </soap:Header>
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;

const ewsRequest = async (body: string): Promise<Document> => {
  const token = await getEwsAccessToken();
  const response = await fetch(EWS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: soapEnvelope(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`EWS request failed: ${response.status} ${error}`);
  }

  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (!doc) {
    throw new Error("Failed to parse EWS response XML");
  }
  return doc;
};

const getElementText = (parent: Element, tagName: string): string | null => {
  const el = parent.getElementsByTagName(tagName)[0];
  return el?.textContent ?? null;
};

const findGitHubFolder = async (): Promise<EwsFolder | null> => {
  const body = `
    <m:FindFolder Traversal="Deep">
      <m:FolderShape>
        <t:BaseShape>Default</t:BaseShape>
      </m:FolderShape>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="msgfolderroot"/>
      </m:ParentFolderIds>
    </m:FindFolder>`;

  const doc = await ewsRequest(body);
  const folderElements = doc.getElementsByTagName("t:Folder");

  for (const folder of folderElements) {
    const displayName = getElementText(folder as Element, "t:DisplayName");
    if (displayName?.toLowerCase() === "github") {
      const folderIdEl =
        (folder as Element).getElementsByTagName("t:FolderId")[0];
      if (folderIdEl) {
        return {
          id: folderIdEl.getAttribute("Id") ?? "",
          changeKey: folderIdEl.getAttribute("ChangeKey") ?? "",
          displayName,
        };
      }
    }
  }

  return null;
};

const findSubFolders = async (parentFolderId: string): Promise<EwsFolder[]> => {
  const body = `
    <m:FindFolder Traversal="Shallow">
      <m:FolderShape>
        <t:BaseShape>Default</t:BaseShape>
      </m:FolderShape>
      <m:ParentFolderIds>
        <t:FolderId Id="${parentFolderId}"/>
      </m:ParentFolderIds>
    </m:FindFolder>`;

  const doc = await ewsRequest(body);
  const folderElements = doc.getElementsByTagName("t:Folder");
  const folders: EwsFolder[] = [];

  for (const folder of folderElements) {
    const folderIdEl =
      (folder as Element).getElementsByTagName("t:FolderId")[0];
    const displayName = getElementText(folder as Element, "t:DisplayName");
    if (folderIdEl && displayName) {
      folders.push({
        id: folderIdEl.getAttribute("Id") ?? "",
        changeKey: folderIdEl.getAttribute("ChangeKey") ?? "",
        displayName,
      });
    }
  }

  return folders;
};

const findEmailsInFolder = async (folderId: string): Promise<EwsEmail[]> => {
  const body = `
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:From"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="1000" Offset="0" BasePoint="Beginning"/>
      <m:Restriction>
        <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
          <t:FieldURI FieldURI="message:From"/>
          <t:Constant Value="notifications@github.com"/>
        </t:Contains>
      </m:Restriction>
      <m:ParentFolderIds>
        <t:FolderId Id="${folderId}"/>
      </m:ParentFolderIds>
    </m:FindItem>`;

  const doc = await ewsRequest(body);
  const messageElements = doc.getElementsByTagName("t:Message");
  const emails: EwsEmail[] = [];

  for (const message of messageElements) {
    const itemIdEl = (message as Element).getElementsByTagName("t:ItemId")[0];
    const subject = getElementText(message as Element, "t:Subject") ?? "";
    const receivedDateTime =
      getElementText(message as Element, "t:DateTimeReceived") ?? "";

    if (itemIdEl) {
      const { repo, prNumber } = parsePrFromSubject(subject);
      emails.push({
        id: itemIdEl.getAttribute("Id") ?? "",
        changeKey: itemIdEl.getAttribute("ChangeKey") ?? "",
        subject,
        receivedDateTime,
        repo,
        prNumber,
      });
    }
  }

  return emails;
};

export const fetchGitHubEmails = async (
  folderName?: string,
): Promise<EwsEmail[]> => {
  const githubFolder = await findGitHubFolder();

  if (!githubFolder) {
    console.log("No 'github' folder found in mailbox.");
    return [];
  }

  const subFolders = await findSubFolders(githubFolder.id);
  const targetFolders = subFolders.length > 0 ? subFolders : [githubFolder];

  const filteredFolders = folderName
    ? targetFolders.filter((f) =>
      f.displayName.toLowerCase() === folderName.toLowerCase()
    )
    : targetFolders;

  if (filteredFolders.length === 0) {
    console.log(
      folderName
        ? `No folder named '${folderName}' found under github/`
        : "No github subfolders found.",
    );
    return [];
  }

  const allEmails: EwsEmail[] = [];

  for (const folder of filteredFolders) {
    console.log(`Scanning folder: github/${folder.displayName}`);
    const emails = await findEmailsInFolder(folder.id);
    allEmails.push(...emails);
  }

  return allEmails;
};

export const moveToTrash = async (
  itemId: string,
  changeKey: string,
): Promise<void> => {
  const body = `
    <m:MoveItem>
      <m:ToFolderId>
        <t:DistinguishedFolderId Id="deleteditems"/>
      </m:ToFolderId>
      <m:ItemIds>
        <t:ItemId Id="${itemId}" ChangeKey="${changeKey}"/>
      </m:ItemIds>
    </m:MoveItem>`;

  await ewsRequest(body);
};

export const batchMoveToTrash = async (
  items: Array<{ id: string; changeKey: string }>,
): Promise<void> => {
  const batchSize = 50;
  const batches = Array.from(
    { length: Math.ceil(items.length / batchSize) },
    (_, i) => items.slice(i * batchSize, (i + 1) * batchSize),
  );

  for (const [index, batch] of batches.entries()) {
    const itemIds = batch
      .map((item) =>
        `<t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/>`
      )
      .join("\n");

    const body = `
      <m:MoveItem>
        <m:ToFolderId>
          <t:DistinguishedFolderId Id="deleteditems"/>
        </m:ToFolderId>
        <m:ItemIds>
          ${itemIds}
        </m:ItemIds>
      </m:MoveItem>`;

    await ewsRequest(body);

    const processed = Math.min((index + 1) * batchSize, items.length);
    console.log(`Moved ${processed}/${items.length} emails to trash`);
  }
};
