import { describe, expect, it } from 'vitest';
import { CertificateTrust, decideCertificate, offersContinue } from './CertificateTrust';

const AUTHORITY = 'net::ERR_CERT_AUTHORITY_INVALID';

describe('offersContinue', () => {
  it('offers it for an unknown authority on this machine', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'app.localhost']) {
      expect(offersContinue(AUTHORITY, host)).toBe(true);
    }
  });

  it('never offers it for another error on this machine', () => {
    for (const error of [
      'net::ERR_CERT_DATE_INVALID',
      'net::ERR_CERT_COMMON_NAME_INVALID',
      'net::ERR_CERT_REVOKED',
      'net::ERR_CERT_WEAK_KEY',
    ]) {
      expect(offersContinue(error, '127.0.0.1')).toBe(false);
    }
  });

  it('never offers it for a host that is not on this machine', () => {
    for (const host of ['example.com', '192.168.1.10', '10.0.0.1', 'localhost.example.com']) {
      expect(offersContinue(AUTHORITY, host)).toBe(false);
    }
  });
});

describe('decideCertificate', () => {
  const pinned = new Set(['sha256/AAAA']);
  const base = { error: AUTHORITY, host: '127.0.0.1', fingerprint: 'sha256/AAAA', pinned };

  it('allows exactly the pinned fingerprint, for the pinned error on a loopback host', () => {
    expect(decideCertificate(base)).toEqual({ allow: true });
  });

  it('denies by default', () => {
    expect(decideCertificate({ ...base, pinned: undefined })).toEqual({ allow: false });
    expect(decideCertificate({ ...base, pinned: new Set() })).toEqual({ allow: false });
  });

  it('denies a different fingerprint', () => {
    expect(decideCertificate({ ...base, fingerprint: 'sha256/BBBB' })).toEqual({ allow: false });
  });

  it('denies any other error code, even for the pinned fingerprint', () => {
    expect(decideCertificate({ ...base, error: 'net::ERR_CERT_DATE_INVALID' })).toEqual({
      allow: false,
    });
  });

  it('denies a host that is not loopback, even with a pin recorded for it', () => {
    expect(decideCertificate({ ...base, host: 'example.com' })).toEqual({ allow: false });
  });
});

describe('CertificateTrust', () => {
  it('keeps approvals per workspace and per host', () => {
    const trust = new CertificateTrust();
    trust.approve('w1', '127.0.0.1', 'sha256/AAAA');
    expect(trust.pinnedFor('w1', '127.0.0.1')).toEqual(new Set(['sha256/AAAA']));
    expect(trust.pinnedFor('w2', '127.0.0.1')).toBeUndefined();
    expect(trust.pinnedFor('w1', 'localhost')).toBeUndefined();
  });

  it('refuses to approve a host that is not loopback', () => {
    const trust = new CertificateTrust();
    trust.approve('w1', 'example.com', 'sha256/AAAA');
    expect(trust.pinnedFor('w1', 'example.com')).toBeUndefined();
  });

  it("forgets one workspace's approvals and no other's", () => {
    const trust = new CertificateTrust();
    trust.approve('w1', '127.0.0.1', 'sha256/AAAA');
    trust.approve('w2', '127.0.0.1', 'sha256/BBBB');
    trust.clearWorkspace('w1');
    expect(trust.pinnedFor('w1', '127.0.0.1')).toBeUndefined();
    expect(trust.pinnedFor('w2', '127.0.0.1')).toEqual(new Set(['sha256/BBBB']));
  });
});
