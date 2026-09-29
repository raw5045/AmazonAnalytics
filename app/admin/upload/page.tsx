import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import { BulkUploader } from './BulkUploader';

export default async function BulkUploadPage() {
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
      <h1 className="text-2xl font-semibold">Bulk upload</h1>
      <p className="mt-2 text-gray-600">
        Select multiple weekly SFR CSVs to upload as one batch. Files upload directly to storage — your files
        never flow through the web server. Each file is validated as it arrives.
      </p>
      <div className="mt-6">
        <BulkUploader />
      </div>
    </div>
  );
}
