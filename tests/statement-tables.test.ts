import { describe, expect, it } from 'vitest';
import { detectTables, tableToMarkdown, type PdfText } from '../src/lib/statements/tables';

// Texto con posición como lo entrega pdf.js: ancho aproximado de 5 pt por carácter.
const t = (page: number, x: number, y: number, str: string): PdfText => ({ page, x, y, width: str.length * 5, str });
const row = (page: number, y: number, date: string, description: string, amount: string) => [t(page, 30, y, date), t(page, 100, y, description), t(page, 400, y, amount)];

describe('detección de tablas en PDF', () => {
  const items = [
    t(1, 30, 40, 'Fecha de corte:'),
    t(1, 200, 40, '04-NOV-2026'),
    t(1, 150, 80, 'CARGOS, ABONOS Y COMPRAS REGULARES'),
    t(1, 150, 90, 'Tarjeta titular XXXX 4172'),
    t(1, 30, 100, 'Fecha'),
    t(1, 100, 100, 'Descripción'),
    t(1, 410, 100, 'Monto'),
    ...row(1, 115, '02-OCT-2026', 'OXXO MERIDA', '+$207.00'),
    t(1, 100, 125, 'SUCURSAL CENTRO'),
    ...row(1, 135, '03-OCT-2026', 'SU PAGO GRACIAS', '-$1,500.00'),
    // La tabla sigue en la página 2 con el mismo título.
    t(2, 150, 80, 'CARGOS, ABONOS Y COMPRAS REGULARES'),
    t(2, 150, 90, 'Tarjeta titular XXXX 4172'),
    ...row(2, 115, '04-OCT-2026', 'AMAZON', '+$99.00'),
    t(2, 30, 300, 'Texto legal que no es tabla.'),
  ];

  it('arma columnas, encabezado, continuaciones y une la tabla entre páginas', () => {
    const tables = detectTables(items);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      pages: [1, 2],
      title: 'CARGOS, ABONOS Y COMPRAS REGULARES',
      subtitle: 'Tarjeta titular XXXX 4172',
      header: ['Fecha', 'Descripción', 'Monto'],
      rows: [
        ['02-OCT-2026', 'OXXO MERIDA SUCURSAL CENTRO', '+$207.00'],
        ['03-OCT-2026', 'SU PAGO GRACIAS', '-$1,500.00'],
        ['04-OCT-2026', 'AMAZON', '+$99.00'],
      ],
    });
  });

  it('no toma como tabla un dato suelto con fecha ("Fecha de corte: …")', () => {
    expect(detectTables(items.slice(0, 2))).toEqual([]);
  });

  it('deja visible un renglón con fecha aunque el resto no venga como texto', () => {
    const tables = detectTables([...row(1, 100, '08-oct-2026', 'APPLE', '$305.50'), t(1, 30, 112, '22-oct-2026'), t(1, 100, 112, '22-oct-2026')]);
    expect(tables[0]!.rows.map((r) => r[0])).toEqual(['08-oct-2026', '22-oct-2026']);
  });

  it('da una vista en Markdown con encabezados genéricos si no hay encabezado', () => {
    const [table] = detectTables(row(1, 100, '08-oct-2026', 'A|B', '$1.00'));
    expect(tableToMarkdown(table!)).toBe('| Columna 1 | Columna 2 | Columna 3 |\n| --- | --- | --- |\n| 08-oct-2026 | A\\|B | $1.00 |');
  });
});
