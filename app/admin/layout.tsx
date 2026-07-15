import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ImportStatusChip } from './ImportStatusChip';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    }
    throw e;
  }
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r p-4">
        <nav className="flex flex-col gap-2">
          <Link href="/admin" className="hover:underline">
            Overview
          </Link>
          <Link href="/admin/rubric" className="hover:underline">
            Schema rubric
          </Link>
          <Link href="/admin/upload" className="hover:underline">
            Bulk upload
          </Link>
          <Link href="/admin/upload/single" className="hover:underline">
            Single upload
          </Link>
          <Link href="/admin/batches" className="hover:underline">
            Upload history
          </Link>
          <Link href="/admin/upload-monthly-sfr" className="hover:underline">
            Monthly SFR upload
          </Link>
          <Link href="/admin/upload-calibration" className="hover:underline">
            Calibration upload
          </Link>
          <Link href="/admin/keepa-enrichment" className="hover:underline">
            Keepa enrichment
          </Link>
          <Link href="/admin/digests" className="hover:underline">
            Weekly digests
          </Link>
          <Link href="/admin/abuse-digest" className="hover:underline">
            Abuse digest
          </Link>
          <hr className="my-2 border-gray-200" />
          <Link href="/explorer" className="hover:underline">
            Keyword explorer
          </Link>
        </nav>
      </aside>
      <div className="flex-1 flex flex-col">
        <ImportStatusChip />
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
