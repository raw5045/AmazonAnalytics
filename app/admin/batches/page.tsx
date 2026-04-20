import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';
import Link from 'next/link';

export default async function BatchesHistoryPage() {
  const batches = await db.query.uploadBatches.findMany({
    orderBy: [desc(uploadBatches.createdAt)],
    limit: 100,
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold">Upload history</h1>
      <table className="mt-4 w-full text-sm">
        <thead className="bg-gray-100 text-left">
          <tr>
            <th className="p-2">Created</th>
            <th className="p-2">Type</th>
            <th className="p-2">Files</th>
            <th className="p-2">Passed / Warned / Failed</th>
            <th className="p-2">Status</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {batches.map((b) => (
            <tr key={b.id}>
              <td className="p-2">{new Date(b.createdAt).toISOString().slice(0, 16)}</td>
              <td className="p-2">{b.batchType}</td>
              <td className="p-2">{b.totalFiles}</td>
              <td className="p-2">{b.passedFiles} / {b.warningFiles} / {b.failedFiles}</td>
              <td className="p-2 font-mono">{b.status}</td>
              <td className="p-2"><Link className="underline" href={`/admin/batches/${b.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
