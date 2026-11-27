// Slack's events for a factory's app (CON-144): what Slack sends to the factory's request URL
// (`slackEventsPath`), and the messages Consola takes as requests, a mention of the bot or a
// direct message to it.
//
// "Cloud · Design: Slack as a Connection (CON-144)", "Events in",
// https://linear.app/consola/document/cloud-design-slack-as-a-connection-con-144-b235f62bdf94

/** The most of an event's body Consola reads: 1 MB. Slack's events are far smaller. */
export const SLACK_EVENT_MAX_BYTES = 1024 * 1024;

/**
 * How far a request's `X-Slack-Request-Timestamp` may be from now, in seconds, either way:
 * Slack's own five minutes. An older request is refused, so a captured one cannot be replayed later.
 */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
