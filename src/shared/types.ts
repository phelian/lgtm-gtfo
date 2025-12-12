export type BaseEmail = {
  id: string;
  subject: string;
  receivedDateTime: string;
  repo: string | null;
  prNumber: number | null;
};

export type GraphEmail = BaseEmail & {
  webLink: string;
};

export type EwsEmail = BaseEmail & {
  changeKey: string;
};

export type MailAppEmail = BaseEmail & {
  messageId: string;
  mailbox: string;
  account: string;
};

export type UnifiedEmail = BaseEmail & {
  changeKey?: string;
  messageId?: string;
  webLink?: string;
  mailbox?: string;
  account?: string;
};
