import { describe, it, expect } from 'vitest';
import { keywordUrlFor } from './links';

describe('keywordUrlFor', () => {
  it('joins the app URL and search term id, stripping trailing slashes from appUrl', () => {
    expect(keywordUrlFor('https://keywordquarry.com', 'id-1')).toBe('https://keywordquarry.com/explorer/keyword/id-1');
    expect(keywordUrlFor('https://keywordquarry.com///', 'id-1')).toBe('https://keywordquarry.com/explorer/keyword/id-1');
  });
});
