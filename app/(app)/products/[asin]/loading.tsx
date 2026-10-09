import { LoadingIndicator } from '@/app/(app)/explorer/LoadingIndicator';

/** The ASIN page while the admin check and the facts read run: title band, facts card and two section blocks. */
export default function ProductLoading() {
  return (
    <>
      <LoadingIndicator label="product" />
      <div className="mx-auto max-w-6xl p-6">
        <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
        <div className="mt-4 h-7 w-[28rem] max-w-full animate-pulse rounded bg-gray-200" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-gray-100" />
        <div className="card-app mt-6 p-4">
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-20 animate-pulse rounded bg-gray-100" />
                <div className="mt-1.5 h-4 w-32 animate-pulse rounded bg-gray-200" />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-8 h-4 w-24 animate-pulse rounded bg-gray-200" />
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card-app h-48 p-4">
              <div className="h-full animate-pulse rounded bg-gray-100" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
