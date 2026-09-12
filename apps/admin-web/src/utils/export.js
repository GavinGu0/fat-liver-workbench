/**
 * 数据导出工具：CSV（带 BOM，Excel 可直接打开）与 .xls（HTML 表格格式，保留列宽与样式）
 */

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function escCsv(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 导出 CSV（UTF-8 BOM，Excel 双击打开不乱码）
 * @param {string} filename 文件名（不含扩展名）
 * @param {string[]} headers 表头
 * @param {Array<Array>} rows 数据行
 */
export function exportCsv(filename, headers, rows) {
  const lines = [headers.map(escCsv).join(',')];
  for (const r of rows) lines.push(r.map(escCsv).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  download(blob, `${filename}.csv`);
}

/**
 * 导出 Excel（.xls，HTML 表格实现，无需依赖库，支持 Excel/WPS 打开）
 * @param {string} filename 文件名（不含扩展名）
 * @param {string} sheetName 工作表名
 * @param {string[]} headers 表头
 * @param {Array<Array>} rows 数据行
 */
export function exportExcel(filename, sheetName, headers, rows) {
  const th = headers.map((h) => `<th style="background:#eef3fb;border:1px solid #c9cdd4;padding:6px 10px;text-align:center">${escHtml(h)}</th>`).join('');
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #e5e6eb;padding:5px 10px;mso-number-format:'\\@';">${escHtml(c)}</td>`).join('')}</tr>`).join('');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${escHtml(sheetName)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
<body><table style="border-collapse:collapse;font-family:微软雅黑;font-size:12px"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  download(blob, `${filename}.xls`);
}
