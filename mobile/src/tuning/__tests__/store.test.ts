/** expo-sqlite is a native module, unavailable under Jest/Node -- this
 * mocks it with a minimal in-memory fake that understands exactly the
 * queries store.ts issues (not a general SQL engine), the same pattern
 * used for the native USB-serial module in fc/__tests__/transport.test.ts. */
interface FakeRow {
  craft_id: string;
  number: number;
  timestamp: number;
  label: string;
  applied_changes: string;
  analysis_summary: string;
}

const fakeRows: FakeRow[] = [];

jest.mock('expo-sqlite', () => ({
  __esModule: true,
  openDatabaseAsync: jest.fn().mockResolvedValue({
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockImplementation(async (_source: string, params: unknown[]) => {
      const [craftId, number, timestamp, label, appliedChanges, analysisSummary] = params as [
        string,
        number,
        number,
        string,
        string,
        string,
      ];
      fakeRows.push({
        craft_id: craftId,
        number,
        timestamp,
        label,
        applied_changes: appliedChanges,
        analysis_summary: analysisSummary,
      });
      return { changes: 1, lastInsertRowId: fakeRows.length };
    }),
    getAllAsync: jest.fn().mockImplementation(async (_source: string, params: unknown[]) => {
      const [craftId] = params as [string];
      return fakeRows
        .filter((r) => r.craft_id === craftId)
        .sort((a, b) => a.number - b.number)
        .map((r) => ({ ...r }));
    }),
  }),
}));

import { craftIdFromName, getLatestIteration, loadIterations, saveIteration } from '../store';

test('craftIdFromName sanitizes names', () => {
  expect(craftIdFromName('Chimera 7!')).toBe('chimera_7_');
  expect(craftIdFromName(null)).toBe('unnamed');
  expect(craftIdFromName('   ')).toBe('unnamed');
});

test('save and load iterations round-trip', async () => {
  const craftId = 'test_craft';
  expect(await loadIterations(craftId)).toEqual([]);

  const it1 = await saveIteration(craftId, 'Baseline', [], { overallGrade: 'FAIR' });
  expect(it1.number).toBe(1);

  const it2 = await saveIteration(
    craftId,
    'Applied',
    [{ parameter: 'd_roll', from: 38, to: 42 }],
    { overallGrade: 'GOOD' }
  );
  expect(it2.number).toBe(2);

  const loaded = await loadIterations(craftId);
  expect(loaded).toHaveLength(2);
  expect(loaded[0].label).toBe('Baseline');
  expect(loaded[1].appliedChanges).toEqual([{ parameter: 'd_roll', from: 38, to: 42 }]);

  expect((await getLatestIteration(craftId))?.number).toBe(2);
});

test('getLatestIteration returns null when empty', async () => {
  expect(await getLatestIteration('brand_new_craft')).toBeNull();
});
