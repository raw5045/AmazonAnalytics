import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import { CalibrationUploader } from './CalibrationUploader';

export default async function UploadCalibrationPage() {
  // Page-level gate, mirroring app/admin/ask-ai/page.tsx: Next 16 renders layouts and pages in
  // parallel, and a client-sent Next-Router-State-Tree can claim the /admin layout already ran, so
  // app/admin/layout.tsx's requireAdmin() is not a guaranteed gate on its own (vendored docs,
  // 01-app/02-guides/authentication.md, "Layouts and auth checks"). Checked here before rendering.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Upload calibration data</h1>
      <p className="mt-2 text-gray-600">
        Combined upload for the volume-estimator model. Pick the monthly
        Brand Analytics SFR report, plus the matching SQP monthly export
        (Brand Analytics → Search Query Performance) and/or POE 30-day
        search-volume CSV, set the month-end-date, and submit. Files upload
        directly to storage, then the worker ingests them in one job. SQP
        trains the rank-to-volume fit; POE is stored as validation data.
      </p>
      <p className="mt-2 text-sm text-gray-500">
        You&apos;ll get an email when processing completes (typically 5-15
        minutes). Uploads that include an SQP file finish with a dry-run
        fit report — β, anchor, MAPE by rank band, and level vs the
        production fit — but nothing goes live until the owner-gated{' '}
        <code className="font-mono text-xs">scripts/fitVolumeModel.ts --persist</code>{' '}
        run. POE-only uploads just store validation data.
      </p>
      <div className="mt-6">
        <CalibrationUploader />
      </div>
    </div>
  );
}
