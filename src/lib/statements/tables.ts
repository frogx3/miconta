/**
 * Tablas de un estado de cuenta en PDF a partir del texto con su posición (lo que da pdf.js en el navegador).
 * No interpreta nada: solo propone tablas para que la persona elija cuál importar y qué es cada columna. Por eso
 * prefiere mostrar de más (una tabla de promociones) que ocultar algo.
 */

export interface PdfText {
  page: number;
  /** Puntos desde la orilla izquierda. */
  x: number;
  /** Puntos desde la orilla de arriba. */
  y: number;
  width: number;
  str: string;
}

export interface DetectedTable {
  /** Páginas donde aparece (una tabla puede seguir en la siguiente). */
  pages: number[];
  /** Renglón en mayúsculas más cercano arriba de la tabla ("CARGOS, ABONOS Y COMPRAS REGULARES"), si lo hay. */
  title: string | null;
  /** Renglón entre título y encabezado que nombra la tarjeta ("Tarjeta adicional XXXX 2455"), si lo hay. */
  subtitle: string | null;
  /** Texto de encabezado de cada columna; vacío si el encabezado no viene como texto. */
  header: string[];
  rows: string[][];
}

interface Cell {
  x0: number;
  x1: number;
  text: string;
}
interface Line {
  page: number;
  y: number;
  cells: Cell[];
}

const SAME_LINE = 2.5;
/** Hueco máximo entre dos textos de la misma celda ("AMAZON" + "MX"). */
const SAME_CELL = 4;
/** Distancia máxima entre renglones de una misma tabla (deja pasar un renglón de continuación). */
const ROW_GAP = 26;
/** Hasta dónde arriba de la tabla se busca su encabezado y su título. */
const HEADER_SPAN = 40;
const TITLE_SPAN = 70;

const DATE = /^\d{1,2}[-/ .]([A-Za-z]{3,4}|\d{1,2})[-/ .]\d{2,4}$/;

function toLines(items: readonly PdfText[]): Line[] {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: { page: number; y: number; items: PdfText[] }[] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === item.page && Math.abs(last.y - item.y) < SAME_LINE) last.items.push(item);
    else lines.push({ page: item.page, y: item.y, items: [item] });
  }
  return lines.map(({ page, y, items: parts }) => {
    const cells: Cell[] = [];
    for (const part of parts.sort((a, b) => a.x - b.x)) {
      const last = cells[cells.length - 1];
      if (last && part.x - last.x1 < SAME_CELL) {
        last.text += (part.x - last.x1 > 0.5 ? ' ' : '') + part.str;
        last.x1 = Math.max(last.x1, part.x + part.width);
      } else cells.push({ x0: part.x, x1: part.x + part.width, text: part.str });
    }
    return { page, y, cells: cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text) };
  });
}

/** Renglón de datos: empieza con una fecha y trae al menos otra celda (un abono sin texto legible también cuenta). */
const isDataRow = (line: Line) => line.cells.length >= 2 && DATE.test(line.cells[0]!.text);
const lineText = (line: Line) => line.cells.map((c) => c.text).join(' ');
const isCardLine = (line: Line) => /\btarjeta\b/i.test(lineText(line)) && /\d{4}\b/.test(lineText(line));
const isTitle = (line: Line) => {
  const text = line.cells.map((c) => c.text).join(' ');
  return /[A-ZÁÉÍÓÚÑ]{3}/.test(text) && text === text.toUpperCase() && !/\d{2}[-/]/.test(text);
};

/** Columnas = intervalos horizontales que se enciman entre renglones (sirve igual para texto a la izquierda y montos a la derecha). */
function columnsOf(lines: readonly Line[]): [number, number][] {
  const spans = lines.flatMap((l) => l.cells.map((c): [number, number] => [c.x0, c.x1])).sort((a, b) => a[0] - b[0]);
  const columns: [number, number][] = [];
  for (const [x0, x1] of spans) {
    const last = columns[columns.length - 1];
    if (last && x0 <= last[1]) last[1] = Math.max(last[1], x1);
    else columns.push([x0, x1]);
  }
  return columns;
}

/** Columna que más se encima con la celda (o la más cercana, para encabezados que se salen del ancho). */
function columnFor(cell: Cell, columns: readonly [number, number][]): number {
  let best = 0;
  let score = -Infinity;
  columns.forEach(([x0, x1], i) => {
    const overlap = Math.min(x1, cell.x1) - Math.max(x0, cell.x0);
    if (overlap > score) [best, score] = [i, overlap];
  });
  return best;
}

function place(line: Line, columns: readonly [number, number][], into: string[]) {
  for (const cell of line.cells) {
    const i = columnFor(cell, columns);
    into[i] = into[i] ? `${into[i]} ${cell.text}` : cell.text;
  }
}

export function detectTables(items: readonly PdfText[]): DetectedTable[] {
  const lines = toLines(items);
  const blocks: { start: number; end: number }[] = [];
  lines.forEach((line, i) => {
    if (!isDataRow(line)) return;
    const block = blocks[blocks.length - 1];
    const previous = block && lines[block.end]!;
    if (block && previous.page === line.page && line.y - previous.y <= ROW_GAP) block.end = i;
    else blocks.push({ start: i, end: i });
  });

  const tables: (DetectedTable & { columnCount: number })[] = blocks.map(({ start, end }) => {
    const body = lines.slice(start, end + 1);
    const first = body[0]!;
    const above = lines.slice(0, start).filter((l) => l.page === first.page && first.y - l.y <= TITLE_SPAN);
    const titleLine = [...above].reverse().find(isTitle) ?? null;
    const below = above.filter((l) => !titleLine || l.y > titleLine.y);
    const cardLine = below.find(isCardLine) ?? null;
    const headerLines = below.filter((l) => first.y - l.y <= HEADER_SPAN && l !== titleLine && l !== cardLine && !isTitle(l));
    const dataLines = body.filter(isDataRow);
    const columns = columnsOf(dataLines);

    const rows: string[][] = [];
    for (const line of body) {
      if (isDataRow(line)) rows.push(Array<string>(columns.length).fill(''));
      // Un renglón sin fecha dentro de la tabla continúa la descripción del de arriba.
      place(line, columns, rows[rows.length - 1]!);
    }
    const header = Array<string>(columns.length).fill('');
    for (const line of headerLines) place(line, columns, header);
    return { pages: [first.page], title: titleLine ? lineText(titleLine) : null, subtitle: cardLine ? lineText(cardLine) : null, header, rows, columnCount: columns.length };
  });

  // Misma tabla que sigue en la página siguiente: mismo título y mismas columnas.
  const merged: typeof tables = [];
  for (const table of tables) {
    const last = merged[merged.length - 1];
    const lastPage = last?.pages[last.pages.length - 1];
    if (last && table.title && last.title === table.title && last.subtitle === table.subtitle && last.columnCount === table.columnCount && lastPage !== undefined && table.pages[0]! - lastPage <= 1 && table.pages[0] !== lastPage) {
      last.pages.push(table.pages[0]!);
      last.rows.push(...table.rows);
    } else merged.push(table);
  }
  return merged.map(({ columnCount: _, ...table }) => table);
}

/** Vista en Markdown de una tabla (para mostrarla o dársela a un agente). */
export function tableToMarkdown(table: DetectedTable): string {
  const escape = (text: string) => text.replace(/\|/g, '\\|');
  const header = table.header.some(Boolean) ? table.header : table.header.map((_, i) => `Columna ${i + 1}`);
  return [header, header.map(() => '---'), ...table.rows].map((row) => `| ${row.map(escape).join(' | ')} |`).join('\n');
}
