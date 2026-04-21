import { SingleUploader } from './SingleUploader';

export default function SingleUploadPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold">Upload single weekly CSV</h1>
      <p className="mt-2 text-gray-600">
        Use this page for ongoing weekly uploads (one file per week).
      </p>
      <div className="mt-6">
        <SingleUploader />
      </div>
    </div>
  );
}
