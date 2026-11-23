/**
 * Whether `bind` names this machine's loopback only: `localhost`, `::1` or an address in
 * `127.0.0.0/8`. A `--dev` host lets anyone holding the pass it prints in, with a lifetime no
 * cell's pass has, so it listens nowhere else; a host bound wider names no platform in its
 * descriptor (`rpcServer.ts`).
 */
export const isLoopback = (bind: string): boolean =>
  bind === 'localhost' || bind === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(bind);
