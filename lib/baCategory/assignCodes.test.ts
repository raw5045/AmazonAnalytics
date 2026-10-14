// lib/baCategory/assignCodes.test.ts
import { describe, it, expect } from 'vitest';
import { assignCodes, MIN_VOTES, prefixesOf, type CrosswalkVote } from './assignCodes';

const HH = 'Health & Household';
const SUPPLIES = `${HH} › Household Supplies`;
const TISSUES = `${SUPPLIES} › Tissues, Toilet Paper & Sprays`;
const TOILET = `${TISSUES} › Toilet Paper`;
const TOWELS = `${TISSUES} › Paper Towels`;
const PET = 'Pet Supplies';
const DOG_TOYS = `${PET} › Dogs › Toys`;
const STORAGE = 'Home & Kitchen › Storage';
const BINS = `${STORAGE} › Bins`;

const vote = (path: string, code: string, products: number): CrosswalkVote => ({ path, code, products });
const byPath = (rows: ReturnType<typeof assignCodes>) => Object.fromEntries(rows.map((r) => [r.categoryPath, r]));

describe('prefixesOf', () => {
  it('lists the path and every ancestor, deepest first, split on the › separator', () => {
    expect(prefixesOf(TOILET)).toEqual([TOILET, TISSUES, SUPPLIES, HH]);
    expect(prefixesOf(HH)).toEqual([HH]);
    const deep = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join(' › ');
    expect(prefixesOf(deep)).toHaveLength(10);
    expect(prefixesOf(deep)[9]).toBe('L1');
  });
});

describe('assignCodes (spec 2026-10-14 §5.2)', () => {
  it('MIN_VOTES is 20', () => {
    expect(MIN_VOTES).toBe(20);
  });

  it('a path with MIN_VOTES votes decides itself by majority; the row records the source, the votes and the share', () => {
    const rows = assignCodes([vote(TOILET, 'Health & Personal Care', 17), vote(TOILET, 'Biss', 3)], [TOILET]);
    expect(rows).toEqual([{ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TOILET, votes: 20, sharePct: 85 }]);
  });

  it('own products decide first: an interior path with enough of its own is not outvoted by its descendants', () => {
    const rows = byPath(assignCodes([vote(STORAGE, 'Kitchen', 20), vote(BINS, 'Home', 30)], [STORAGE, BINS]));
    expect(rows[STORAGE]).toEqual({ categoryPath: STORAGE, code: 'Kitchen', sourcePath: STORAGE, votes: 20, sharePct: 100 });
    expect(rows[BINS]).toEqual({ categoryPath: BINS, code: 'Home', sourcePath: BINS, votes: 30, sharePct: 100 });
  });

  it('under the threshold a path borrows its parent: the nearest ancestor with MIN_VOTES votes decides', () => {
    // Toilet paper has 5 votes (Biss); its sibling paper towels has 25 (Health & Personal Care). The parent holds 30.
    const votes = [vote(TOILET, 'Biss', 5), vote(TOWELS, 'Health & Personal Care', 25)];
    const rows = byPath(assignCodes(votes, [TOILET, TOWELS]));
    expect(rows[TOILET]).toEqual({ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TISSUES, votes: 30, sharePct: 83 });
    expect(rows[TOWELS]).toEqual({ categoryPath: TOWELS, code: 'Health & Personal Care', sourcePath: TOWELS, votes: 25, sharePct: 100 });
  });

  it('one code sums across sibling paths at their parent', () => {
    const votes = [vote(TOILET, 'Health & Personal Care', 12), vote(TOWELS, 'Health & Personal Care', 10), vote(TOWELS, 'Biss', 5)];
    const rows = assignCodes(votes, [TOILET]);
    expect(rows).toEqual([{ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TISSUES, votes: 27, sharePct: 81 }]);
  });

  it('a thin interior path (under the threshold of its own) is decided by its whole subtree, at itself', () => {
    const rows = assignCodes([vote(STORAGE, 'Kitchen', 5), vote(BINS, 'Home', 30)], [STORAGE]);
    expect(rows).toEqual([{ categoryPath: STORAGE, code: 'Home', sourcePath: STORAGE, votes: 35, sharePct: 86 }]);
  });

  it('a catalog path with no votes of its own takes the nearest ancestor that has enough', () => {
    const rows = assignCodes([vote(TOWELS, 'Health & Personal Care', 20)], [TOILET]);
    expect(rows).toEqual([{ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TISSUES, votes: 20, sharePct: 100 }]);
  });

  it('backs off level by level up to the department', () => {
    const rows = assignCodes([vote(`${HH} › Vitamins`, 'Health & Personal Care', 20)], [TOILET]);
    expect(rows[0]).toMatchObject({ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: HH, votes: 20 });
  });

  it('a department under the threshold still decides when it has any vote; one with none gives no row', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Pet Products', 3)], [DOG_TOYS, `${PET} › Cats`, 'Gift Cards › Restaurants']);
    expect(rows).toEqual([
      { categoryPath: `${PET} › Cats`, code: 'Pet Products', sourcePath: PET, votes: 3, sharePct: 100 },
      { categoryPath: DOG_TOYS, code: 'Pet Products', sourcePath: PET, votes: 3, sharePct: 100 },
    ]);
  });

  it('exactly MIN_VOTES decides; one fewer backs off', () => {
    const at = assignCodes([vote(TOILET, 'Biss', 20), vote(TOWELS, 'Home', 100)], [TOILET]);
    expect(at[0]).toMatchObject({ code: 'Biss', sourcePath: TOILET, votes: 20 });
    const under = assignCodes([vote(TOILET, 'Biss', 19), vote(TOWELS, 'Home', 100)], [TOILET]);
    expect(under[0]).toMatchObject({ code: 'Home', sourcePath: TISSUES, votes: 119 });
  });

  it('ties break by code text ascending, deterministically', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Toys', 10), vote(DOG_TOYS, 'Apparel', 10)], [DOG_TOYS]);
    expect(rows[0]).toMatchObject({ code: 'Apparel', votes: 20, sharePct: 50 });
  });

  it('rounds the share to a whole percent', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Pet Products', 14), vote(DOG_TOYS, 'Toys', 7)], [DOG_TOYS]);
    expect(rows[0]).toMatchObject({ code: 'Pet Products', sourcePath: DOG_TOYS, votes: 21, sharePct: 67 });
  });

  it('rounds an exact half up', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Pet Products', 113), vote(DOG_TOYS, 'Toys', 87)], [DOG_TOYS]);
    expect(rows[0]).toMatchObject({ code: 'Pet Products', votes: 200, sharePct: 57 }); // 56.5 rounds up to 57
  });

  it('ignores a non-positive or NaN vote where it would count', () => {
    const votes = [vote(DOG_TOYS, 'Pet Products', 22), vote(DOG_TOYS, 'Toys', -4), vote(DOG_TOYS, 'Apparel', Number.NaN)];
    expect(assignCodes(votes, [DOG_TOYS])).toEqual([{ categoryPath: DOG_TOYS, code: 'Pet Products', sourcePath: DOG_TOYS, votes: 22, sharePct: 100 }]);
  });

  it('de-duplicates and sorts the catalog paths, and never invents a path', () => {
    const votes = [vote(DOG_TOYS, 'Pet Products', 25), vote(DOG_TOYS, 'Toys', 0), vote(TOWELS, 'Home', -4)];
    const rows = assignCodes(votes, [DOG_TOYS, PET, DOG_TOYS]);
    expect(rows.map((r) => r.categoryPath)).toEqual([PET, DOG_TOYS]);
    expect(rows.every((r) => r.code === 'Pet Products')).toBe(true);
    expect(rows.find((r) => r.categoryPath === DOG_TOYS)?.sharePct).toBe(100);
  });

  it('is pure and order-independent: reversed inputs give the same rows (a tie included); the inputs are untouched', () => {
    const votes = [vote(DOG_TOYS, 'Toys', 10), vote(DOG_TOYS, 'Apparel', 10), vote(TOILET, 'Biss', 30)];
    const paths = [TOILET, DOG_TOYS, TOWELS];
    const a = assignCodes(votes, paths);
    expect(assignCodes([...votes].reverse(), [...paths].reverse())).toEqual(a);
    expect(a.find((r) => r.categoryPath === DOG_TOYS)?.code).toBe('Apparel');
    expect(paths).toEqual([TOILET, DOG_TOYS, TOWELS]);
    expect(votes).toEqual([vote(DOG_TOYS, 'Toys', 10), vote(DOG_TOYS, 'Apparel', 10), vote(TOILET, 'Biss', 30)]);
  });
});
