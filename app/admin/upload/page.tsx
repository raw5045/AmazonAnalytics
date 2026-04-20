import { BulkUploader } from './BulkUploader';

export default function BulkUploadPage() {
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
