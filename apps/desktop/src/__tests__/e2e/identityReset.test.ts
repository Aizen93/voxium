import { describe, it, expect } from 'vitest';
import { shouldOfferIdentityReset } from '../../components/dm/E2EControls';
import type { E2EOwnDevices } from '../../services/e2e/e2eService';

// Who is offered "start a new account identity" (spec §14.4)?
//
// This is the only destructive action in the E2E surface: it replaces the
// account key, forces every contact to re-verify, and strips the approval from
// every other device. Offering it one state too early puts it in front of
// people whose actual problem is "approve this device from your other one".

const devices = (
  entries: Array<{ id: string; crossSigned: boolean }>,
  currentDeviceId: string,
  capabilityServed = true
): E2EOwnDevices => ({
  currentDeviceId,
  devices: entries.map((e) => ({
    deviceId: e.id,
    curve25519Key: 'c',
    ed25519Key: 'e',
    deviceSignature: 's',
    masterSignature: e.crossSigned ? 'm' : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    crossSigned: e.crossSigned,
  })),
  listVersion: 1,
  masterKey: 'M',
  canApprove: false,
  capabilityServed,
});

describe('shouldOfferIdentityReset', () => {
  it('is NOT offered while another device could still approve this one', () => {
    // The ordinary second-device setup: A holds the key, B is waiting. The
    // answer here is "approve B from A", and resetting would destroy A's
    // approval to fix nothing.
    const ownDevices = devices(
      [
        { id: 'A', crossSigned: true },
        { id: 'B', crossSigned: false },
      ],
      'B'
    );
    expect(shouldOfferIdentityReset({ ownDevices, canApprove: false, masterKeyConflict: false })).toBe(
      false
    );
  });

  it('is offered when no device of the account is signed any more', () => {
    // The reinstall that lost the vault: nothing left can approve anything, so
    // a new identity is the only way back.
    const ownDevices = devices([{ id: 'B', crossSigned: false }], 'B');
    expect(shouldOfferIdentityReset({ ownDevices, canApprove: false, masterKeyConflict: false })).toBe(
      true
    );
  });

  it('is offered for an account key this device can neither prove nor replace', () => {
    const ownDevices = devices([{ id: 'A', crossSigned: true }], 'A');
    expect(shouldOfferIdentityReset({ ownDevices, canApprove: true, masterKeyConflict: true })).toBe(
      true
    );
  });

  it('is NOT offered to a device that holds the account key, or to a healthy account', () => {
    const withUnsigned = devices(
      [
        { id: 'A', crossSigned: true },
        { id: 'B', crossSigned: false },
      ],
      'A'
    );
    // A can just approve B
    expect(
      shouldOfferIdentityReset({ ownDevices: withUnsigned, canApprove: true, masterKeyConflict: false })
    ).toBe(false);

    const healthy = devices([{ id: 'A', crossSigned: true }], 'A');
    expect(shouldOfferIdentityReset({ ownDevices: healthy, canApprove: false, masterKeyConflict: false })).toBe(
      false
    );
  });

  it('is NOT offered on an answer that could not report signatures at all', () => {
    // A node mid-rolling-deploy does not understand cross-signing, so every
    // device comes back looking unsigned. Reading absence of evidence as "no
    // device can approve me" would put the destructive action in front of
    // ordinary users for the duration of every deploy.
    const ownDevices = devices([{ id: 'B', crossSigned: false }], 'B', false);
    expect(shouldOfferIdentityReset({ ownDevices, canApprove: false, masterKeyConflict: false })).toBe(
      false
    );
    // …not even with a conflict flag, which that same answer cannot justify
    expect(shouldOfferIdentityReset({ ownDevices, canApprove: false, masterKeyConflict: true })).toBe(
      false
    );
  });

  it('is NOT offered before the device list has loaded', () => {
    expect(shouldOfferIdentityReset({ ownDevices: null, canApprove: false, masterKeyConflict: false })).toBe(
      false
    );
  });
});
