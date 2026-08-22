import { describe, it, expect, vi } from 'vitest';
import { repairIpBanSpellings } from '../../utils/ipBans';

function store(rows: Array<{ id: string; ip: string }>) {
  return {
    ipBan: {
      findMany: vi.fn().mockResolvedValue(rows),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('repairIpBanSpellings — bans written before the write side normalized', () => {
  it('rewrites a row in a non-canonical spelling to the form readers query', async () => {
    const db = store([{ id: 'b1', ip: '2001:DB8::1' }, { id: 'b2', ip: '::ffff:cb00:7107' }]);

    const result = await repairIpBanSpellings(db);

    expect(result).toEqual({ rewritten: 2, merged: 0 });
    expect(db.ipBan.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { ip: '2001:db8::1' } });
    expect(db.ipBan.update).toHaveBeenCalledWith({ where: { id: 'b2' }, data: { ip: '203.0.113.7' } });
    expect(db.ipBan.delete).not.toHaveBeenCalled();
  });

  it('drops a non-canonical duplicate when the canonical row already exists — rewriting would hit the unique index', async () => {
    const db = store([{ id: 'good', ip: '2001:db8::1' }, { id: 'dead', ip: '2001:DB8:0:0:0:0:0:1' }]);

    const result = await repairIpBanSpellings(db);

    expect(result).toEqual({ rewritten: 0, merged: 1 });
    expect(db.ipBan.delete).toHaveBeenCalledWith({ where: { id: 'dead' } });
    expect(db.ipBan.update).not.toHaveBeenCalled();
  });

  it('merges two non-canonical spellings of the same address into one rewritten row', async () => {
    const db = store([{ id: 'a', ip: '2001:DB8::1' }, { id: 'b', ip: '2001:db8:0:0:0:0:0:1' }]);

    const result = await repairIpBanSpellings(db);

    expect(result).toEqual({ rewritten: 1, merged: 1 });
    expect(db.ipBan.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { ip: '2001:db8::1' } });
    expect(db.ipBan.delete).toHaveBeenCalledWith({ where: { id: 'b' } });
  });

  it('touches nothing when every row is already canonical', async () => {
    const db = store([{ id: 'a', ip: '203.0.113.7' }, { id: 'b', ip: 'fe80::1' }]);

    const result = await repairIpBanSpellings(db);

    expect(result).toEqual({ rewritten: 0, merged: 0 });
    expect(db.ipBan.update).not.toHaveBeenCalled();
    expect(db.ipBan.delete).not.toHaveBeenCalled();
  });
});
