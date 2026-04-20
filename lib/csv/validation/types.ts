export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  rowNumber?: number;
  columnName?: string;
}

export interface ValidationStats {
  rowCount: number;
  blankConversionShareCount: { p1: number; p2: number; p3: number };
  blankClickShareCount: { p1: number; p2: number; p3: number };
  blankShareByCategory: Record<string, number>;
  rowsWithAnyBlankShare: number;
}
