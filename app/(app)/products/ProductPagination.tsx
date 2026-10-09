import { PaginationControls } from '@/app/(app)/explorer/Pagination';

/**
 * The Products page's pager: the explorer's Prev / "Page N of M" / Next controls, kept on /products
 * (they carry the current URL's other params and drop `page` for page 1). The count is exact up to
 * PRODUCT_COUNT_CAP, which is the last page the URL parse accepts (200 pages of 50), so Next stops
 * there and a capped count reads "of 200+". Past the last page it renders nothing: the results area
 * says so and links back to page 1.
 */
export function ProductPagination({
  page,
  total,
  totalIsCapped,
  pageSize,
}: {
  page: number;
  total: number;
  totalIsCapped: boolean;
  pageSize: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) return null;
  return (
    <PaginationControls page={page} hasNext={page < totalPages} basePath="/products">
      {` of ${totalPages.toLocaleString('en-US')}${totalIsCapped ? '+' : ''}`}
    </PaginationControls>
  );
}
