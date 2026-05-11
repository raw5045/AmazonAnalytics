import { describe, it, expect } from 'vitest';
import { looseTokenForms, looseTokenFormsBidirectional, looseMatch, looseTitleNorm } from './looseMatch';

describe('looseTokenForms (singularization only)', () => {
  // -ies cascade
  it('expands -ies plurals', () => {
    expect(looseTokenForms('gummies')).toEqual(['gummies', 'gummy', 'gummie']);
    expect(looseTokenForms('batteries')).toEqual(['batteries', 'battery', 'batterie']);
    expect(looseTokenForms('calories')).toEqual(['calories', 'calory', 'calorie']);
  });
  it('skips -ies cascade for short words but still falls to -s strip', () => {
    expect(looseTokenForms('dies')).toEqual(['dies', 'die']);
    expect(looseTokenForms('ties')).toEqual(['ties', 'tie']);
  });

  // -es family
  it('strips -es after sibilant clusters', () => {
    expect(looseTokenForms('boxes')).toEqual(['boxes', 'box']);
    expect(looseTokenForms('brushes')).toEqual(['brushes', 'brush']);
    expect(looseTokenForms('glasses')).toEqual(['glasses', 'glass']);
    expect(looseTokenForms('benches')).toEqual(['benches', 'bench']);
  });

  // -s strip
  it('strips trailing -s for regular plurals', () => {
    expect(looseTokenForms('supplements')).toEqual(['supplements', 'supplement']);
    expect(looseTokenForms('powders')).toEqual(['powders', 'powder']);
    expect(looseTokenForms('bars')).toEqual(['bars', 'bar']);
    expect(looseTokenForms('teas')).toEqual(['teas', 'tea']);
    expect(looseTokenForms('fibers')).toEqual(['fibers', 'fiber']);
    expect(looseTokenForms('boys')).toEqual(['boys', 'boy']);
  });

  // Suffix guards
  it('does not strip -ss / -us / -is', () => {
    expect(looseTokenForms('stress')).toEqual(['stress']);
    expect(looseTokenForms('virus')).toEqual(['virus']);
    expect(looseTokenForms('analysis')).toEqual(['analysis']);
  });

  // Exact exceptions
  it('keeps exception words intact', () => {
    expect(looseTokenForms('gas')).toEqual(['gas']);
    expect(looseTokenForms('series')).toEqual(['series']);
    expect(looseTokenForms('species')).toEqual(['species']);
    expect(looseTokenForms('lens')).toEqual(['lens']);
  });

  // Non-plural
  it('leaves non-plural words alone', () => {
    expect(looseTokenForms('creatine')).toEqual(['creatine']);
    expect(looseTokenForms('supplement')).toEqual(['supplement']);
  });
});

describe('looseTokenFormsBidirectional', () => {
  // Already covered by singularization, plus add pluralization where applicable.
  it('returns both directions for regular plural inputs', () => {
    expect(looseTokenFormsBidirectional('supplements').sort())
      .toEqual(['supplement', 'supplements'].sort());
  });
  it('adds plural form for regular singular inputs', () => {
    expect(looseTokenFormsBidirectional('supplement').sort())
      .toEqual(['supplement', 'supplements'].sort());
    expect(looseTokenFormsBidirectional('creatine').sort())
      .toEqual(['creatine', 'creatines'].sort());
  });
  it('adds -ies plural for consonant+y singulars', () => {
    expect(looseTokenFormsBidirectional('gummy').sort())
      .toEqual(['gummies', 'gummy'].sort());
    expect(looseTokenFormsBidirectional('battery').sort())
      .toEqual(['batteries', 'battery'].sort());
  });
  it('does not add -ies for vowel+y singulars (just adds -s)', () => {
    expect(looseTokenFormsBidirectional('boy').sort())
      .toEqual(['boy', 'boys'].sort());
    expect(looseTokenFormsBidirectional('day').sort())
      .toEqual(['day', 'days'].sort());
  });
  it('adds -es plural for sibilant singulars', () => {
    expect(looseTokenFormsBidirectional('box').sort())
      .toEqual(['box', 'boxes'].sort());
    expect(looseTokenFormsBidirectional('brush').sort())
      .toEqual(['brush', 'brushes'].sort());
    expect(looseTokenFormsBidirectional('tax').sort())
      .toEqual(['tax', 'taxes'].sort());
  });
  it('handles already-plural inputs from -ies family symmetrically', () => {
    expect(looseTokenFormsBidirectional('gummies').sort())
      .toEqual(['gummie', 'gummies', 'gummy'].sort());
  });
  it('preserves exceptions in both directions', () => {
    expect(looseTokenFormsBidirectional('gas')).toEqual(['gas']);
    expect(looseTokenFormsBidirectional('series')).toEqual(['series']);
  });
  it('does not pluralize -ss / -us / -is endings', () => {
    expect(looseTokenFormsBidirectional('stress')).toEqual(['stress']);
    expect(looseTokenFormsBidirectional('virus')).toEqual(['virus']);
    expect(looseTokenFormsBidirectional('analysis')).toEqual(['analysis']);
  });
});

describe('looseTitleNorm', () => {
  it('pads with single spaces', () => {
    expect(looseTitleNorm('Creatine Gummies')).toBe(' creatine gummies ');
  });
  it('strips apostrophes', () => {
    expect(looseTitleNorm("Beekeeper's Naturals")).toBe(' beekeepers naturals ');
  });
  it('collapses non-alphanumeric to space', () => {
    expect(looseTitleNorm('Creatine-Gummies, 60ct!')).toBe(' creatine gummies 60ct ');
  });
  it('collapses runs of whitespace', () => {
    expect(looseTitleNorm('  Creatine    Gummies  ')).toBe(' creatine gummies ');
  });
  it('returns null for null input', () => {
    expect(looseTitleNorm(null)).toBe(null);
  });
});

describe('looseMatch (end-to-end)', () => {
  it('matches plural search vs singular title', () => {
    expect(looseMatch('creatine supplements', 'Creatine Gummies Supplement')).toBe(true);
  });
  it('matches singular search vs plural title', () => {
    expect(looseMatch('creatine supplement', 'Creatine Supplements')).toBe(true);
  });
  it('matches "Creatine Gummies" vs "Creatine Sugar Free Gummies"', () => {
    expect(looseMatch('creatine gummies', 'Creatine Sugar Free Gummies')).toBe(true);
  });
  it('matches with apostrophes in title', () => {
    expect(looseMatch('beekeepers honey', "Beekeeper's Naturals Honey Spray")).toBe(true);
  });
  it('matches with hyphenated title', () => {
    expect(looseMatch('creatine gummies', 'Pure Creatine-Gummies 60ct')).toBe(true);
  });
  it('returns null when title is null', () => {
    expect(looseMatch('anything', null)).toBe(null);
  });
  it('returns false when title omits a required token', () => {
    expect(looseMatch('magnesium glycinate', 'Vitamin C Gummies')).toBe(false);
  });
  it('ignores stopwords on the search side', () => {
    expect(looseMatch('the protein', 'Premium Protein Powder')).toBe(true);
    expect(looseMatch('the best protein', 'Premium Protein Powder')).toBe(false);
  });
  it('handles powder/powders correctly (both directions)', () => {
    expect(looseMatch('protein powders', 'Premium Protein Powder')).toBe(true);
    expect(looseMatch('protein powder', 'Premium Protein Powders')).toBe(true);
  });
  it('handles tea/teas (both directions)', () => {
    expect(looseMatch('green teas', 'Premium Green Tea Bags')).toBe(true);
    expect(looseMatch('green tea', 'Premium Green Teas Bag')).toBe(true);
  });
  it('handles gummy/gummies (both directions)', () => {
    expect(looseMatch('gummy vitamins', 'Gummies Multi Vitamin')).toBe(true);
    expect(looseMatch('gummies vitamin', 'Gummy Multi Vitamins')).toBe(true);
  });
  it('handles box/boxes (sibilant + es)', () => {
    expect(looseMatch('storage box', 'Storage Boxes 5 Pack')).toBe(true);
    expect(looseMatch('storage boxes', 'Storage Box Set')).toBe(true);
  });
  it('rejects suffix-guarded tokens that fall short', () => {
    expect(looseMatch('stress relief', 'Stres Relief Tablets')).toBe(false);
    expect(looseMatch('virus protection', 'Viru Protection')).toBe(false);
  });
});
