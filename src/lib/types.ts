export type EmailThread = {
  id: string;
  subject: string;
  preview: string;
  sender: string;
  receivedAt: string;
};

export type BucketName =
  | "Important"
  | "Can wait"
  | "Auto-archive"
  | "Newsletter"
  | string;

export type BucketedThreads = Record<BucketName, EmailThread[]>;
