/**
 * The host's HTTP origin, which t3 registers as the backend's `httpBaseUrl`, from the address a
 * page gives: `http(s)://host:port`, or the socket's own `ws(s)://host:port`, which names the same
 * host over `http(s)://`. Throws, as `new URL` does, on an address that is not a URL.
 */
export const hostHttpOrigin = (hostUrl: string): string => {
  const url = new URL(hostUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.origin;
};
