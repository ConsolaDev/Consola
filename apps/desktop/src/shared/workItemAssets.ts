/**
 * Images inside a work item — a screenshot pasted into a PR, a badge in a
 * bot's description — load through main rather than straight from the web.
 *
 * Two reasons. An image pasted into a private repository is readable only
 * by a signed-in account, and that account's token must never reach the
 * renderer. And which URLs need it is the provider's knowledge, which the
 * renderer must not branch on. So every image in a work item is addressed
 * as `consola-asset://image/?workspace=…&url=…`, and main decides how to
 * fetch it as that workspace's account.
 */
export const WORK_ITEM_ASSET_SCHEME = 'consola-asset';

const ASSET_HOST = 'image';
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/** The web address of an image, or null for anything else: relative paths, data:, file:. */
export function webImageUrl(src: string): URL | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  return WEB_PROTOCOLS.has(url.protocol) ? url : null;
}

/**
 * The address the renderer loads `src` from, or undefined when it should not
 * load at all. Only web images qualify: a relative path would resolve
 * against the app's own files, and nothing else is something a work item
 * can legitimately point at.
 */
export function workItemAssetUrl(workspaceId: string, src: string | undefined): string | undefined {
  const url = src ? webImageUrl(src) : null;
  if (!url) return undefined;
  const asset = new URL(`${WORK_ITEM_ASSET_SCHEME}://${ASSET_HOST}/`);
  asset.searchParams.set('workspace', workspaceId);
  asset.searchParams.set('url', url.href);
  return asset.href;
}

/** The inverse of workItemAssetUrl, for main. Null for anything it would not have produced. */
export function parseWorkItemAssetUrl(href: string): { workspaceId: string; url: URL } | null {
  let asset: URL;
  try {
    asset = new URL(href);
  } catch {
    return null;
  }
  if (asset.protocol !== `${WORK_ITEM_ASSET_SCHEME}:` || asset.hostname !== ASSET_HOST) return null;
  const workspaceId = asset.searchParams.get('workspace');
  const url = webImageUrl(asset.searchParams.get('url') ?? '');
  return workspaceId && url ? { workspaceId, url } : null;
}
