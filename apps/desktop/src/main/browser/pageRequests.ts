import type { WebContents } from 'electron';

/**
 * What a page may ask for through its own web contents that Electron would
 * otherwise answer itself, and answer yes: each is answered no here, from
 * the page's first moment, on every guest (`secureGuest`) and every popup
 * (`hardenPopup`). The partition's own requests (permissions, devices, the
 * screen, downloads) are `configurePartition`'s.
 *
 * - A client certificate. Electron's default sends the first matching
 *   identity in the system store, which can carry the person's name, email
 *   and employer, to any https page or request that asks, and an agent can
 *   cause that just by navigating. None is sent: a site that requires one
 *   does not load here.
 * - A Bluetooth device. Heard and not prevented, Electron picks the first
 *   device that matches, with no chooser. None is picked.
 */
export function refusePageRequests(contents: WebContents): void {
  contents.on('select-client-certificate', (event, _url, _certificates, callback) => {
    event.preventDefault();
    // No certificate: the connection goes on without one.
    (callback as (certificate?: Electron.Certificate) => void)();
  });
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
}
