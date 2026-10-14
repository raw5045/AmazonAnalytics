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

  it('under the threshold a path borrows its parent: the nearest ancestor with MIN_VOTES votes decides', () => {
    // Toilet paper has 5 votes (Biss); its sibling paper towels has 25 (Health & Personal Care). The parent holds 30.
    const votes = [vote(TOILET, 'Biss', 5), vote(TOWELS, 'Health & Personal Care', 25)];
    const rows = byPath(assignCodes(votes, [TOILET, TOWELS]));
    expect(rows[TOILET]).toEqual({ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TISSUES, votes: 30, sharePct: 83 });
    expect(rows[TOWELS]).toEqual({ categoryPath: TOWELS, code: 'Health & Personal Care', sourcePath: TOWELS, votes: 25, sharePct: 100 });
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
    const rows = assignCodes([vote(DOG_TOYS, 'Pet Products', 2), vote(DOG_TOYS, 'Toys', 1)], [DOG_TOYS], 3);
    expect(rows[0]).toMatchObject({ code: 'Pet Products', votes: 3, sharePct: 67 });
  });

  it('de-duplicates and sorts the catalog paths, ignores non-positive votes, and never invents a path', () => {
    const votes = [vote(DOG_TOYS, 'Pet Products', 25), vote(DOG_TOYS, 'Toys', 0), vote(TOWELS, 'Home', -4)];
    const rows = assignCodes(votes, [DOG_TOYS, PET, DOG_TOYS]);
    expect(rows.map((r) => r.categoryPath)).toEqual([PET, DOG_TOYS]);
    expect(rows.every((r) => r.code === 'Pet Products')).toBe(true);
    expect(rows.find((r) => r.categoryPath === DOG_TOYS)?.sharePct).toBe(100);
  });

  it('is pure: the same input gives the same output and the inputs are untouched', () => {
    const votes = [vote(TOILET, 'Biss', 30)];
    const paths = [TOWELS, TOILET];
    const a = assignCodes(votes, paths);
    const b = assignCodes(votes, paths);
    expect(a).toEqual(b);
    expect(paths).toEqual([TOWELS, TOILET]);
    expect(votes).toEqual([vote(TOILET, 'Biss', 30)]);
  });
});
