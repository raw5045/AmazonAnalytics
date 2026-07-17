import { CalibrationUploader } from './CalibrationUploader';

export default function UploadCalibrationPage() {
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
        production fit — but nothing goes live until the owner-gated
        `scripts/fitVolumeModel.ts --persist` run. POE-only uploads just
        store validation data.
      </p>
      <div className="mt-6">
        <CalibrationUploader />
      </div>
    </div>
  );
}
