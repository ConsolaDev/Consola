import { z } from 'zod';

export interface WorkItemComment {
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  kind: 'comment' | 'review' | 'inline';
  state?: string;
  path?: string;
  line?: number;
}

export interface WorkItemDetails {
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  author: string;
  labels: string[];
  assignees: string[];
  comments: WorkItemComment[];
  checks: { name: string; state: string; url: string }[];
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
  headOid?: string;
  headBranch?: string;
  baseBranch?: string;
  mergeState?: string;
  reviewDecision?: string;
}

const body = z.string().trim().min(1).max(65536);
export const workItemMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), body }),
  z.object({ kind: z.literal('review'), event: z.enum(['approve', 'request-changes', 'comment']), body: z.string().trim().max(65536) }),
  z.object({ kind: z.literal('close') }),
  z.object({ kind: z.literal('reopen') }),
  z.object({ kind: z.literal('ready'), draft: z.boolean() }),
  z.object({ kind: z.literal('merge'), method: z.enum(['squash', 'merge', 'rebase']), headOid: z.string().regex(/^[a-f0-9]{40,64}$/i), auto: z.boolean() }),
  z.object({ kind: z.literal('edit'), title: z.string().trim().min(1).max(256), body: z.string().max(65536) }),
]);
export type WorkItemMutation = z.infer<typeof workItemMutationSchema>;
