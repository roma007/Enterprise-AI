/** 本地时间 YYYY-MM-DD HH:mm；文档生成时间统一用它，避免 UTC 偏差。 */
export function fmtLocalDateTime(value: Date | string = new Date()): string {
  return new Date(value).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
}
