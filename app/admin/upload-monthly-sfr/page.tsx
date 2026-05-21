import { MonthlySfrUploader } from './MonthlySfrUploader';

export default function UploadMonthlySfrPage() {
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
