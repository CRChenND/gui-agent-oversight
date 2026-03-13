export const baseBadgeClassName =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 shadow-sm';

export const badgeVariants = {
  neutral: 'border-slate-200 bg-slate-50 text-slate-700',
  primary: 'border-blue-200 bg-blue-50 text-blue-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  info: 'border-sky-200 bg-sky-50 text-sky-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-rose-200 bg-rose-50 text-rose-700',
} as const;

export function badgeClassName(variant: keyof typeof badgeVariants = 'neutral'): string {
  return `${baseBadgeClassName} ${badgeVariants[variant]}`;
}
