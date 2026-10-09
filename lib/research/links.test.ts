import { describe, it, expect } from 'vitest';
import { keywordUrlFor, productUrlFor } from './links';

describe('keywordUrlFor', () => {
  it('joins the app URL and search term id, stripping trailing slashes from appUrl', () => {
    expect(keywordUrlFor('https://keywordquarry.com', 'id-1')).toBe('https://keywordquarry.com/explorer/keyword/id-1');
    expect(keywordUrlFor('https://keywordquarry.com///', 'id-1')).toBe('https://keywordquarry.com/explorer/keyword/id-1');
  });
});

describe('productUrlFor', () => {
  it('joins the app URL and the ASIN under /products, stripping trailing slashes from appUrl as keywordUrlFor does', () => {
    expect(productUrlFor('https://keywordquarry.com', 'B0ABCDEF12')).toBe('https://keywordquarry.com/products/B0ABCDEF12');
    expect(productUrlFor('https://keywordquarry.com///', 'B0ABCDEF12')).toBe('https://keywordquarry.com/products/B0ABCDEF12');
  });
});
