import { describe, expect, it } from 'vitest';
import { parseWorkItemAssetUrl, workItemAssetUrl } from './workItemAssets';

describe('workItemAssetUrl', () => {
  it('round-trips a web image through the asset scheme', () => {
    const src = 'https://github.com/user-attachments/assets/0f4b1c2e-1234-4abc-9def-000000000000';
    const asset = workItemAssetUrl('ws-1', src);
    expect(asset).toMatch(/^consola-asset:\/\/image\/\?/);
    expect(parseWorkItemAssetUrl(asset!)).toEqual({ workspaceId: 'ws-1', url: new URL(src) });
  });

  it('keeps query strings and encoded characters in the original URL intact', () => {
    const src = 'https://developer.mend.io/api/mc/badges/age/npm/@mui%2ficons-material/7.3.11?slim=true&x=a%26b';
    const parsed = parseWorkItemAssetUrl(workItemAssetUrl('ws', src)!);
    expect(parsed?.url.href).toBe(new URL(src).href);
  });

  it('refuses anything that is not a web image', () => {
    for (const src of [undefined, '', 'docs/screenshot.png', '/etc/passwd', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:alert(1)']) {
      expect(workItemAssetUrl('ws', src)).toBeUndefined();
    }
  });
});

describe('parseWorkItemAssetUrl', () => {
  it('rejects URLs it did not produce', () => {
    expect(parseWorkItemAssetUrl('https://github.com/user-attachments/assets/x')).toBeNull();
    expect(parseWorkItemAssetUrl('consola-asset://other/?workspace=ws&url=https%3A%2F%2Fexample.com%2Fa.png')).toBeNull();
    expect(parseWorkItemAssetUrl('consola-asset://image/?url=https%3A%2F%2Fexample.com%2Fa.png')).toBeNull();
    expect(parseWorkItemAssetUrl('consola-asset://image/?workspace=ws&url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull();
    expect(parseWorkItemAssetUrl('not a url')).toBeNull();
  });
});
