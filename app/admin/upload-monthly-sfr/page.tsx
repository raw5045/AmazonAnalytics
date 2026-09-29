import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import { MonthlySfrUploader } from './MonthlySfrUploader';

export default async function UploadMonthlySfrPage() {
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
      <h1 className="text-2xl font-semibold">Upload monthly BA SFR</h1>
      <p className="mt-2 text-gray-600">
        Upload an Amazon Brand Analytics monthly Search Terms export. The file
        is sent directly to storage (it never flows through this server, so
        large files work fine). Processing happens in the background — you can
        close this page after the upload finishes; status is visible in the
        Inngest dashboard.
      </p>
      <p className="mt-2 text-sm text-gray-500">
        Used by the volume-estimator calibration. Re-upload monthly to keep
        the rank-to-volume model fresh.
      </p>
      <div className="mt-6">
        <MonthlySfrUploader />
      </div>
    </div>
  );
}
