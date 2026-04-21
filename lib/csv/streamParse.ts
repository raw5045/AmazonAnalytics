import { parse, type Parser } from 'csv-parse';
import { Readable, Transform } from 'node:stream';

export interface StreamParseOptions {
  /** If true, drop the very first line before parsing headers. Default true. */
  skipMetadataRow?: boolean;
}

/**
 * Async iterable that yields CSV rows as Record<string,string>, keyed by header.
 * Strips a UTF-8 BOM if present. By default, drops the first row (metadata) so
 * the second row becomes the header row.
 */
export async function* streamParseCsv(
  input: Readable,
  opts: StreamParseOptions = {},
): AsyncGenerator<Record<string, string>> {
  const skipMetadata = opts.skipMetadataRow ?? true;

  const source: Readable = skipMetadata ? input.pipe(stripFirstLine()) : input;
  const bomStripped = source.pipe(stripBom());

  const parser: Parser = bomStripped.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    }),
  );

  for await (const row of parser) {
    yield row as Record<string, string>;
  }
}

function stripBom(): Transform {
  let stripped = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!stripped) {
        stripped = true;
        if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
          cb(null, chunk.slice(3));
          return;
        }
      }
      cb(null, chunk);
    },
  });
}

function stripFirstLine(): Transform {
  let buffer = '';
  let dropped = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (dropped) {
        cb(null, chunk);
        return;
      }
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const rest = buffer.slice(nl + 1);
        buffer = '';
        dropped = true;
        cb(null, Buffer.from(rest, 'utf8'));
      } else {
        cb();
      }
    },
    flush(cb) {
      cb(null, dropped ? null : Buffer.alloc(0));
    },
  });
}
