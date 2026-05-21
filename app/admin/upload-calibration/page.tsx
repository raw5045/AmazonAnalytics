import { CalibrationUploader } from './CalibrationUploader';

export default function UploadCalibrationPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Upload calibration data</h1>
      <p className="mt-2 text-gray-600">
        Combined upload for the volume-estimator model. Pick the monthly
        Brand Analytics SFR report and the matching POE 30-day search-volume
        export, set the month-end-date, and submit. Both files upload
        directly to storage, then the worker ingests them and fits a new
        rank-to-volume model in one job.
      </p>
      <p className="mt-2 text-sm text-gray-500">
        You&apos;ll get an email when the fit completes (typically 5-15
        minutes) with the resulting β, scale factor, and MAPE by rank
        band. The new model applies to weeks in this month immediately
        — future fits never overwrite past estimates.
      </p>
      <div className="mt-6">
        <CalibrationUploader />
      </div>
    </div>
  );
}
