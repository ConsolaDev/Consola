// The cell's tables, each exported from here so `drizzle-kit generate` finds it
// (drizzle.config.ts). None yet: the first arrive with the cell's first feature.
//
// Every table carries a not-null `workspace_id` (the workspace's id in cloud-global), and a
// person is a column holding their global id, never a copy of their account. `schema.test.ts`
// checks both.
export {};
