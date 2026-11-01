import type { SensitivityStage } from '../types';

const round = (v: number, digits = 4) => Number(v.toFixed(digits));

/** 传导链连乘。派生变量不参与（它只是展示用的结果）。 */
export function chainProduct(stages: SensitivityStage[]): number | null {
  const active = stages.filter((s) => !s.is_derived);
  if (active.length === 0) return null;
  if (active.some((s) => s.mult_base === 0)) return 0;
  return round(active.reduce((acc, s) => acc * s.mult_base, 1));
}

export interface StageImpact {
  stage: number;
  variableKey: string;
  variableLabel: string;
  baseValue: number | null;
  lowValue: number | null;
  unit: string | null;
  multBase: number;
  multLow: number | null;
  shape: 'linear' | 'threshold';
  thresholdNote: string | null;
  controllable: boolean;
  ownerRole: string | null;
  /** 这一段恶化、其余保持基准时的可实现收益 */
  realizedIfLow: number | null;
  /** 相对基准的损失（正数） */
  loss: number | null;
}

/** 单段恶化：其余各段保持基准，只把这一段换成 mult_low。
 *  注意这是线性近似——阈值型变量（如准确率跌破 90%）的真实后果更糟，
 *  所以输出里单独带 shape / thresholdNote，让调用方不要把它当线性外推。 */
export function stageImpacts(theory: number, stages: SensitivityStage[]): StageImpact[] {
  const active = stages.filter((s) => !s.is_derived).sort((a, b) => a.stage - b.stage);
  const baseProduct = chainProduct(active);
  const baseRealized = baseProduct === null ? null : round(theory * baseProduct, 1);

  return active.map((s) => {
    const multLow = s.mult_low ?? s.mult_base;
    const product = round(
      active.reduce((acc, x) => acc * (x.variable_key === s.variable_key ? multLow : x.mult_base), 1),
    );
    const realizedIfLow = round(theory * product, 1);
    return {
      stage: s.stage,
      variableKey: s.variable_key,
      variableLabel: s.variable_label,
      baseValue: s.base_value,
      lowValue: s.low_value,
      unit: s.unit,
      multBase: s.mult_base,
      multLow: s.mult_low,
      shape: s.shape,
      thresholdNote: s.threshold_note,
      controllable: s.controllable,
      ownerRole: s.owner_role,
      realizedIfLow,
      loss: baseRealized === null ? null : round(baseRealized - realizedIfLow, 1),
    };
  });
}

export const THRESHOLD_WARNING =
  '阈值型变量不能按线性外推：跌破断崖后收益归零，而不是平滑下降。';
