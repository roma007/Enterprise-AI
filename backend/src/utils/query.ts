import { z } from 'zod';

/** Query string 里的布尔值：明确支持 1/0/true/false，避免 Boolean("0") === true。 */
export function queryBool(defaultValue = false) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return value;
  }, z.boolean());
}
