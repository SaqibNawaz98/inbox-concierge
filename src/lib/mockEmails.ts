import type { EmailThread } from "@/lib/types";

export const MOCK_THREADS: EmailThread[] = [
  {
    id: "t_001",
    subject: "Q2 planning notes",
    preview: "Sharing my first draft for review before Friday...",
    sender: "manager@company.com",
    receivedAt: "2026-04-28T09:12:00.000Z",
  },
  {
    id: "t_002",
    subject: "50% off annual subscription",
    preview: "Limited-time offer expires tonight.",
    sender: "deals@newsletter.com",
    receivedAt: "2026-04-29T11:03:00.000Z",
  },
  {
    id: "t_003",
    subject: "Design feedback requested",
    preview: "Can you leave comments on the latest mockups?",
    sender: "designer@company.com",
    receivedAt: "2026-04-29T14:47:00.000Z",
  },
  {
    id: "t_004",
    subject: "New comment on your PR",
    preview: "Please address the async error handling concern.",
    sender: "github-noreply@github.com",
    receivedAt: "2026-04-30T07:30:00.000Z",
  },
  {
    id: "t_005",
    subject: "Weekly roundup",
    preview: "Here are this week's top AI engineering reads.",
    sender: "digest@newsletter.com",
    receivedAt: "2026-04-30T08:01:00.000Z",
  },
];
