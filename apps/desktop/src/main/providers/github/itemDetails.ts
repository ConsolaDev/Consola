import { z } from 'zod';

// Validate remote JSON before presenting it as a usable detail response.
const user = z.object({ login: z.string() }).nullable().optional();
export const githubDetailSchema = z.object({
  title: z.string(), body: z.string().nullable().optional(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  author: user, isDraft: z.boolean().optional(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  headRefOid: z.string().optional(), headRefName: z.string().optional(), baseRefName: z.string().optional(),
  mergeStateStatus: z.string().optional(), reviewDecision: z.string().nullable().optional(),
  statusCheckRollup: z.array(z.object({
    name: z.string().optional(), context: z.string().optional(), state: z.string().optional(),
    status: z.string().optional(), conclusion: z.string().nullable().optional(),
    detailsUrl: z.string().nullable().optional(), targetUrl: z.string().nullable().optional(),
  })).nullable().optional(),
});
export const githubCommentSchema = z.object({
  id: z.number(), user, body: z.string().nullable().optional(), html_url: z.string().optional(),
  created_at: z.string().optional(), submitted_at: z.string().nullable().optional(),
  state: z.string().optional(), path: z.string().optional(),
  line: z.number().nullable().optional(), original_line: z.number().nullable().optional(),
});
export const githubFileSchema = z.object({
  filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number(), patch: z.string().optional(),
});
