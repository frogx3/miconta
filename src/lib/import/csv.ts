const DELIMITERS = [',', ';', '\t'] as const;

/** Quita BOM y detecta el delimitador contando separadores fuera de comillas en la primera línea. */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) break;
    else if (!inQuotes && char in counts) counts[char]!++;
  }
  return DELIMITERS.reduce((best, d) => (counts[d]! > counts[best]! ? d : best), ',' as (typeof DELIMITERS)[number]);
}

/** Parser CSV (RFC 4180): comillas, comillas escapadas, CRLF/LF, BOM, filas vacías omitidas. */
export function parseCsv(input: string, delimiter: ',' | ';' | '\t' | 'auto' = 'auto'): string[][] {
  const text = input.replace(/^﻿/, '');
  const sep = delimiter === 'auto' ? detectDelimiter(text) : delimiter;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
