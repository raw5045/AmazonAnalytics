import { describe, it, expect } from 'vitest';
import { looseTokenForms, looseMatch } from './looseMatch';

describe('looseTokenForms', () => {
  // -ies cascade
  it('expands -ies plurals', () => {
    expect(looseTokenForms('gummies')).toEqual(['gummies', 'gummy', 'gummie']);
    expect(looseTokenForms('batteries')).toEqual(['batteries', 'battery', 'batterie']);
    expect(looseTokenForms('calories')).toEqual(['calories', 'calory', 'calorie']);
  });
  it('skips -ies cascade for short words but still falls to -s strip', () => {
    // Length 4, fails > 4 guard for -ies cascade; falls through to -s
    // strip (length > 3, ends in 's', not ss/us/is, not exception).
    expect(looseTokenForms('dies')).toEqual(['dies', 'die']);
    expect(looseTokenForms('ties')).toEqual(['ties', 'tie']);
  });

  // -es family
  it('strips -es after sibilant clusters', () => {
    expect(looseTokenForms('boxes')).toEqual(['boxes', 'box']);
    expect(looseTokenForms('brushes')).toEqual(['brushes', 'brush']);
    expect(looseTokenForms('glasses')).toEqual(['glasses', 'glass']);
    // Note: quizzes -> quizz is an imperfect stem (true singular is "quiz"),
    // but the rule strips only the -es suffix. The original "quizzes" stays in
    // the candidate set, so the only miss is "quizzes" search vs "quiz" title
    // (rare in product search).
    expect(looseTokenForms('quizzes')).toEqual(['quizzes', 'quizz']);
    expect(looseTokenForms('benches')).toEqual(['benches', 'bench']);
  });

  // -s strip (the big domain win)
  it('strips trailing -s for regular plurals', () => {
    expect(looseTokenForms('supplements')).toEqual(['supplements', 'supplement']);
    expect(looseTokenForms('powders')).toEqual(['powders', 'powder']);
    expect(looseTokenForms('bars')).toEqual(['bars', 'bar']);
    expect(looseTokenForms('teas')).toEqual(['teas', 'tea']);
    expect(looseTokenForms('fibers')).toEqual(['fibers', 'fiber']);
    expect(looseTokenForms('boys')).toEqual(['boys', 'boy']);
  });

  // Suffix guards
  it('does not strip -ss', () => {
    expect(looseTokenForms('stress')).toEqual(['stress']);
    expect(looseTokenForms('class')).toEqual(['class']);
    expect(looseTokenForms('miss')).toEqual(['miss']);
  });
  it('does not strip -us', () => {
    expect(looseTokenForms('virus')).toEqual(['virus']);
    expect(looseTokenForms('focus')).toEqual(['focus']);
    expect(looseTokenForms('bonus')).toEqual(['bonus']);
  });
  it('does not strip -is', () => {
    expect(looseTokenForms('analysis')).toEqual(['analysis']);
    expect(looseTokenForms('crisis')).toEqual(['crisis']);
    expect(looseTokenForms('arthritis')).toEqual(['arthritis']);
  });

  // Exact exceptions
  it('keeps explicit non-plural words intact', () => {
    expect(looseTokenForms('gas')).toEqual(['gas']);
    expect(looseTokenForms('news')).toEqual(['news']);
    expect(looseTokenForms('hers')).toEqual(['hers']);
    expect(looseTokenForms('series')).toEqual(['series']);
    expect(looseTokenForms('species')).toEqual(['species']);
    expect(looseTokenForms('lens')).toEqual(['lens']);
  });

  // Length guards
  it('does not strip very short tokens', () => {
    expect(looseTokenForms('is')).toEqual(['is']);
    expect(looseTokenForms('as')).toEqual(['as']);
    expect(looseTokenForms('us')).toEqual(['us']);
  });

  // Non-plural words
  it('leaves non-plural words alone', () => {
    expect(looseTokenForms('creatine')).toEqual(['creatine']);
    expect(looseTokenForms('magnesium')).toEqual(['magnesium']);
  });
});

describe('looseMatch (end-to-end)', () => {
  it('matches the motivating example: plural search vs singular title', () => {
    expect(looseMatch('creatine supplements', 'Creatine Gummies Supplement')).toBe(true);
  });
  it('matches singular search vs plural title', () => {
    expect(looseMatch('creatine supplement', 'Creatine Supplements')).toBe(true);
  });
  it('matches "Creatine Gummies" vs "Creatine Sugar Free Gummies"', () => {
    expect(looseMatch('creatine gummies', 'Creatine Sugar Free Gummies')).toBe(true);
  });
  it('matches with apostrophes in title', () => {
    // Note: input is search_term_normalized form, so apostrophes already stripped.
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
    // "the" is a stopword; "protein" is the only required token.
    expect(looseMatch('the protein', 'Premium Protein Powder')).toBe(true);
    // Sanity: a non-stopword content word that the title omits → false.
    expect(looseMatch('the best protein', 'Premium Protein Powder')).toBe(false);
  });
  it('handles powder/powders correctly', () => {
    expect(looseMatch('protein powders', 'Premium Protein Powder')).toBe(true);
    expect(looseMatch('protein powder', 'Premium Protein Powders')).toBe(true);
  });
  it('handles tea/teas', () => {
    expect(looseMatch('green teas', 'Premium Green Tea Bags')).toBe(true);
  });
});
