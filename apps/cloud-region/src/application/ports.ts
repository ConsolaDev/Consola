// What the use cases need from the world outside, each implemented by an adapter.

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};
