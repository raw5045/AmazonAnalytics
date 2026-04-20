import { rubricUploadedFn } from './rubric';
import { validateFileFn } from './validate';
import { importFileFn } from './importFile';
import { importBatchFn } from './importBatch';

export const functions = [rubricUploadedFn, validateFileFn, importFileFn, importBatchFn];
