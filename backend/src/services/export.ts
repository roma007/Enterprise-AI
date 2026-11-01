import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { marked } from 'marked';

const FONT = '微软雅黑';
const MONO = 'Consolas';

export interface ExportMeta {
  title: string;
  client: string;
  project: string;
  version: string;
}

const cleanInline = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();

function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? 0;
    if (idx > last) runs.push(new TextRun(text.slice(last, idx)));
    const token = match[0];
    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), font: MONO, size: 18, color: '334155' }));
    }
    last = idx + token.length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  return runs.length ? runs : [new TextRun(text)];
}

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  const cells = parseRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function buildTable(header: string[], rows: string[][]): Table {
  const cellMargins = { top: 60, bottom: 60, left: 80, right: 80 };
  const headerRow = new TableRow({
    tableHeader: true,
    children: header.map(
      (cell) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' },
          margins: cellMargins,
          children: [new Paragraph({ children: inlineRuns(cleanInline(cell)) })],
        }),
    ),
  });

  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: header.map(
          (_, i) =>
            new TableCell({
              margins: cellMargins,
              children: [new Paragraph({ children: inlineRuns(cleanInline(row[i] ?? '')) })],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E8EEF5' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'E8EEF5' },
    },
  });
}

/** 把报告 Markdown 的常用子集转成 Word 段落/表格。 */
function buildBlocks(markdown: string): Array<Paragraph | Table> {
  const lines = markdown.split(/\r?\n/);
  const out: Array<Paragraph | Table> = [];
  let i = 0;

  const pushParagraph = (text: string, opts: Record<string, any> = {}) => {
    if (!text.trim()) return;
    out.push(
      new Paragraph({
        children: inlineRuns(cleanInline(text)),
        spacing: { after: 100 },
        ...opts,
      }),
    );
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw;
    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++;
      if (lang === 'mermaid') {
        out.push(
          new Paragraph({
            children: [
              new TextRun({
                text: '（依赖图见系统内「机会点依赖图」；下方为依赖明细）',
                italics: true,
                color: '64748B',
                size: 18,
              }),
            ],
            spacing: { before: 80, after: 100 },
          }),
        );
      } else {
        for (const codeLine of code) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: codeLine, font: MONO, size: 18, color: '334155' })],
              shading: { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' },
              spacing: { after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      }
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(
        new Paragraph({
          children: inlineRuns(cleanInline(heading[2])),
          heading:
            level === 1
              ? HeadingLevel.HEADING_1
              : level === 2
                ? HeadingLevel.HEADING_2
                : level === 3
                  ? HeadingLevel.HEADING_3
                  : HeadingLevel.HEADING_4,
          spacing: { before: level === 1 ? 0 : 240, after: 120 },
        }),
      );
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      out.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E2E8F0' } },
          spacing: { after: 160 },
        }),
      );
      i++;
      continue;
    }

    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!isSeparator(lines[i])) rows.push(parseRow(lines[i]));
        i++;
      }
      if (rows.length) out.push(buildTable(rows[0], rows.slice(1)));
      out.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      for (const q of quote) {
        out.push(
          new Paragraph({
            children: inlineRuns(cleanInline(q)),
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: '93C5FD' } },
            shading: { type: ShadingType.CLEAR, fill: 'F8FBFF', color: 'auto' },
            indent: { left: 240 },
            spacing: { after: 60 },
          }),
        );
      }
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^[-*]\s+/, '');
        out.push(
          new Paragraph({
            children: inlineRuns(cleanInline(text)),
            bullet: { level: 0 },
            spacing: { after: 40 },
          }),
        );
        i++;
      }
      continue;
    }

    const numbered = line.match(/^(\d+)\.\s+(.*)$/);
    if (numbered) {
      out.push(
        new Paragraph({
          children: inlineRuns(cleanInline(`${numbered[1]}. ${numbered[2]}`)),
          indent: { left: 240 },
          spacing: { after: 40 },
        }),
      );
      i++;
      continue;
    }

    // 普通段落：合并连续的非空、非特殊行
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|>\s?|[-*]\s|\d+\.\s|\||```|---+$)/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    pushParagraph(para.join(' '));
  }

  return out;
}

export async function buildDocx(markdown: string, meta: ExportMeta): Promise<Buffer> {
  const blocks = buildBlocks(markdown);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 21, color: '1F2937' },
          paragraph: { spacing: { line: 300, after: 80 } },
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 36, bold: true, color: '0F172A', font: FONT },
          paragraph: { spacing: { before: 0, after: 200 } },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 28, bold: true, color: '0F172A', font: FONT },
          paragraph: { spacing: { before: 280, after: 140 } },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 23, bold: true, color: '1E293B', font: FONT },
          paragraph: { spacing: { before: 220, after: 100 } },
        },
        {
          id: 'Heading4',
          name: 'Heading 4',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 21, bold: true, color: '334155', font: FONT },
          paragraph: { spacing: { before: 180, after: 80 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 900, right: 900, bottom: 900, left: 900 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${meta.client} · ${meta.title} · ${meta.version}`,
                    size: 16,
                    color: '94A3B8',
                    font: FONT,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '第 ', size: 16, color: '94A3B8', font: FONT }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '94A3B8', font: FONT }),
                  new TextRun({ text: ' 页 / 共 ', size: 16, color: '94A3B8', font: FONT }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '94A3B8', font: FONT }),
                  new TextRun({ text: ' 页', size: 16, color: '94A3B8', font: FONT }),
                ],
              }),
            ],
          }),
        },
        children: blocks,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function buildPrintHtml(markdown: string, meta: ExportMeta, autoPrint = false): string {
  const html = String(marked.parse(markdown, { gfm: true, breaks: true }));
  // 打印版不嵌入 Mermaid 运行时；依赖图在系统内看，这里保留紧随其后的明细表
  const body = html.replace(
    /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g,
    '<div class="mermaid-note">机会点依赖图见系统内「机会点依赖图」；下方为依赖明细表。</div>',
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)} · ${escapeHtml(meta.client)}</title>
<style>
  :root { --ink:#0f172a; --ink-2:#334155; --ink-3:#64748b; --line:#e2e8f0; --brand:#2563eb; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eef2f7; color:var(--ink-2); font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif; font-size:13px; line-height:1.8; }
  .toolbar { position:fixed; top:18px; right:18px; z-index:10; }
  .toolbar button { border:1px solid #2563eb; background:#2563eb; color:#fff; border-radius:9px; padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer; box-shadow:0 6px 18px rgba(37,99,235,.25); }
  .doc { max-width:860px; margin:28px auto 60px; background:#fff; padding:52px 56px; border-radius:14px; box-shadow:0 12px 40px rgba(15,23,42,.08); }
  h1 { font-size:26px; line-height:1.35; color:var(--ink); margin:0 0 18px; padding-bottom:12px; border-bottom:2px solid var(--ink); }
  h2 { font-size:18px; color:var(--ink); margin:30px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); page-break-after:avoid; }
  h3 { font-size:15px; color:var(--ink); margin:22px 0 8px; page-break-after:avoid; }
  h4 { font-size:13.5px; color:var(--ink-2); margin:16px 0 6px; page-break-after:avoid; }
  p { margin:8px 0; }
  ul, ol { margin:8px 0; padding-left:22px; }
  li { margin:3px 0; }
  blockquote { margin:12px 0; padding:9px 14px; border-left:3px solid #93c5fd; background:#f8fbff; border-radius:0 8px 8px 0; color:var(--ink-2); }
  blockquote p { margin:3px 0; }
  table { width:100%; border-collapse:collapse; margin:12px 0; font-size:12px; page-break-inside:avoid; }
  th, td { border:1px solid var(--line); padding:8px 10px; vertical-align:top; text-align:left; }
  th { background:#f1f5f9; color:var(--ink); font-weight:600; }
  code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; background:#f1f5f9; border-radius:4px; padding:1px 5px; }
  pre { background:#0b1220; color:#dbe4f3; padding:14px 16px; border-radius:10px; overflow:auto; page-break-inside:avoid; }
  pre code { background:none; color:inherit; padding:0; }
  hr { border:none; border-top:1px dashed var(--line); margin:22px 0; }
  strong { color:var(--ink); }
  .mermaid-note { margin:12px 0; padding:10px 14px; border:1px dashed var(--line); border-radius:8px; color:var(--ink-3); background:#f8fafc; font-size:12px; }
  @page { size:A4; margin:16mm 15mm; }
  @media print {
    body { background:#fff; }
    .toolbar { display:none; }
    .doc { margin:0; padding:0; max-width:none; box-shadow:none; border-radius:0; }
    h2 { page-break-before:auto; }
    table, pre, blockquote { page-break-inside:avoid; }
  }
</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">打印 / 另存 PDF</button></div>
  <main class="doc">
${body}
  </main>
  <script>${autoPrint ? 'window.addEventListener("load", () => setTimeout(() => window.print(), 300));' : ''}</script>
</body>
</html>`;
}
