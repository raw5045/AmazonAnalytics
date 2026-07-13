import { LoadingIndicator } from './LoadingIndicator';
import { ExplorerSkeleton } from './ExplorerSkeleton';

export default function ExplorerLoading() {
  return (
    <>
      <LoadingIndicator label="keyword explorer" />
      <ExplorerSkeleton />
    </>
  );
}
