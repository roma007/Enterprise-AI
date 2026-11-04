/** CSV 单元格转义 + Excel 公式注入防护。 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvResponse(body: string): string {
  return `\uFEFF${body}`;
}
