import type { WebContents } from 'electron';
import { isLoopbackHost } from '../../shared/browser';

/** The one error a person may click past, and only on their own machine. */
const OVERRIDABLE_ERROR = 'net::ERR_CERT_AUTHORITY_INVALID';

/**
 * Whether "Continue anyway" is on offer: a certificate no known authority
 * signed (a dev server's own), for a host on this machine. Every other
 * error is a real warning (wrong name, expired, revoked) and every other
 * host could be someone in the middle; neither is the person's to wave
 * through.
 */
export function offersContinue(error: string, host: string): boolean {
  return error === OVERRIDABLE_ERROR && isLoopbackHost(host);
}

export interface CertificateQuestion {
  error: string;
  host: string;
  fingerprint: string;
  /** The fingerprints the person approved for this host, in this workspace. */
  pinned: ReadonlySet<string> | undefined;
}

/**
 * Whether a certificate Chromium rejected is let through. Denied unless the
 * person approved exactly this certificate for this host, and what is being
 * overridden is still the one thing that may be (`offersContinue`): a pin
 * never widens to another error, host or certificate.
 */
export function decideCertificate(question: CertificateQuestion): { allow: boolean } {
  const { error, host, fingerprint, pinned } = question;
  return { allow: offersContinue(error, host) && pinned?.has(fingerprint) === true };
}

/** A main-frame certificate refusal, kept so the person can be asked about it. */
export interface DeniedCertificate {
  url: string;
  host: string;
  error: string;
  fingerprint: string;
}

/**
 * Certificate approvals, in memory and per workspace: they last until the
 * app quits, "Clear browsing data" or the workspace is deleted. Pinned to the
 * certificate's fingerprint, so a server that later presents another
 * certificate is asked about again.
 *
 * Also the one place a page's `certificate-error` is answered (`guard`), for
 * guests and popups alike: both are the same untrusted pages in one
 * partition.
 */
export class CertificateTrust {
  private readonly approved = new Map<string, Map<string, Set<string>>>();
  /** The latest main-frame refusal of each guarded contents, by its id. */
  private readonly denied = new Map<number, DeniedCertificate>();

  public approve(workspaceId: string, host: string, fingerprint: string): void {
    // Loopback only, enforced here as well as at the decision: an approval
    // that could never be used is not stored.
    if (!isLoopbackHost(host)) return;
    const hosts = this.approved.get(workspaceId) ?? new Map<string, Set<string>>();
    const pins = hosts.get(host) ?? new Set<string>();
    pins.add(fingerprint);
    hosts.set(host, pins);
    this.approved.set(workspaceId, hosts);
  }

  public pinnedFor(workspaceId: string, host: string): ReadonlySet<string> | undefined {
    return this.approved.get(workspaceId)?.get(host);
  }

  public clearWorkspace(workspaceId: string): void {
    this.approved.delete(workspaceId);
  }

  /** The refusal a guarded contents last met on its main frame, if any. */
  public deniedFor(contentsId: number): DeniedCertificate | undefined {
    return this.denied.get(contentsId);
  }

  /** Approves what a contents was last refused, and says what it was. Undefined when nothing was offered. */
  public approveDenied(workspaceId: string, contentsId: number): DeniedCertificate | undefined {
    const denied = this.denied.get(contentsId);
    if (!denied || !offersContinue(denied.error, denied.host)) return undefined;
    this.approve(workspaceId, denied.host, denied.fingerprint);
    return denied;
  }

  /**
   * Answers a contents' certificate errors: allows an approved certificate and
   * leaves everything else to Electron's default, which is refusal. Only a
   * main-frame refusal is remembered, since only that is the page's own.
   * `contentsId` is read by the caller up front (a destroyed contents throws
   * on `.id`).
   */
  public guard(contents: WebContents, workspaceId: string, contentsId: number): void {
    contents.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      const verdict = decideCertificate({
        error,
        host,
        fingerprint: certificate.fingerprint,
        pinned: this.pinnedFor(workspaceId, host),
      });
      if (verdict.allow) {
        event.preventDefault();
        callback(true);
        return;
      }
      if (isMainFrame) {
        this.denied.set(contentsId, { url, host, error, fingerprint: certificate.fingerprint });
      }
    });
    contents.once('destroyed', () => this.denied.delete(contentsId));
  }
}
