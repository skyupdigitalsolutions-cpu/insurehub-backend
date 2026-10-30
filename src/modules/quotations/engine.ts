/**
 * The quotation premium (Section 11, GR-24). Fixed order: base → riders → override → discount → GST.
 * Full precision until the final amount, which is rounded ONCE, half-up, to 2 decimals. Pure: no database.
 */
export interface Rider { name: string; priceType: 'FIXED' | 'PERCENT'; value: number }
export interface EngineInput {
  mode: 'RATE_TABLE' | 'MANUAL_ENTRY';
  base: number;                     // RATE_TABLE: the rate row; MANUAL_ENTRY: the typed net premium (riders included)
  riders: Rider[];                  // RATE_TABLE only
  taxPercent?: number;              // RATE_TABLE: the price version's tax %
  taxAmount?: number;               // MANUAL_ENTRY: the tax typed from the insurer portal
  override?: { amount: number; reason: string } | null;
  discount?: { kind: 'AMOUNT' | 'PERCENT'; value: number; reference: string } | null;
}
export interface Breakdown {
  base: number; riders: Array<{ name: string; amount: number }>; ridersTotal: number; calculated: number;
  override: number | null; beforeDiscount: number; discount: number; afterDiscount: number;
  taxPercent: number | null; tax: number; final: number;
}

/** Half-up to 2 decimals, done once at the end (also correct for x.xx5 values that binary floats store slightly low). */
export const roundHalfUp = (x: number) => Math.sign(x) * Math.round((Math.abs(x) + 1e-9) * 100) / 100;

export class EngineError extends Error { constructor(public messageId: 'QT-09' | 'QT-19' | 'QT-37') { super(messageId); } }

export function calculate(i: EngineInput): Breakdown {
  const riders = i.mode === 'RATE_TABLE' ? i.riders.map((r) => ({ name: r.name, amount: r.priceType === 'FIXED' ? r.value : (i.base * r.value) / 100 })) : [];
  const ridersTotal = riders.reduce((t, r) => t + r.amount, 0);
  const calculated = i.base + ridersTotal;
  const beforeDiscount = i.override ? i.override.amount : calculated;
  let discount = 0;
  if (i.discount && i.discount.value > 0) {
    if (!i.discount.reference?.trim()) throw new EngineError('QT-37');
    discount = i.discount.kind === 'AMOUNT' ? i.discount.value : (beforeDiscount * i.discount.value) / 100;
    if (discount > beforeDiscount) throw new EngineError('QT-09');
    if (discount > calculated) throw new EngineError('QT-19');
  }
  const afterDiscount = beforeDiscount - discount;
  const tax = i.mode === 'RATE_TABLE' ? (afterDiscount * (i.taxPercent ?? 0)) / 100 : (i.taxAmount ?? 0);
  return {
    base: i.base, riders, ridersTotal, calculated, override: i.override?.amount ?? null, beforeDiscount, discount, afterDiscount,
    taxPercent: i.mode === 'RATE_TABLE' ? (i.taxPercent ?? 0) : null, tax, final: roundHalfUp(afterDiscount + tax),
  };
}