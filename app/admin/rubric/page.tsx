import { RubricUploader } from './RubricUploader';

export default function RubricPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold">Schema rubric</h1>
      <p className="mt-2 text-gray-600">
        Upload a single Amazon SFR CSV. We will detect the schema and let you approve it as version 1.
      </p>
      <div className="mt-6">
        <RubricUploader />
      </div>
    </div>
  );
}
