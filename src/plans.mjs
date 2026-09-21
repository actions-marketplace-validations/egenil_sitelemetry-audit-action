// Public plan catalogue (GET /api/plans) used for the neutral plan/usage section.
const KIND_LABELS = Object.freeze({
  full: 'Full', security: 'Security', seo: 'SEO', ai: 'AI visibility', accessibility: 'Accessibility',
  performance: 'Performance', integrations: 'Integrations', 'search-console': 'Search Console'
});

export const kindLabel = (id) => KIND_LABELS[id] || String(id);

export function normalizePlans(list) {
  if (!Array.isArray(list)) return null;
  const plans = list
    .filter((plan) => plan && typeof plan === 'object' && typeof plan.id === 'string')
    .map((plan) => ({
      id: plan.id,
      label: typeof plan.label === 'string' ? plan.label : plan.id,
      monthly: Number.isFinite(plan.price?.monthly) ? plan.price.monthly : null,
      currency: typeof plan.price?.currency === 'string' ? plan.price.currency : 'USD',
      auditKinds: Array.isArray(plan.auditKinds) ? plan.auditKinds.map(String) : [],
      moduleCount: Number.isFinite(plan.moduleCount) ? plan.moduleCount : Array.isArray(plan.modules) ? plan.modules.length : null,
      securityScans: Number.isFinite(plan.commercial?.securityScans) ? plan.commercial.securityScans : null
    }));
  return plans.length ? plans : null;
}

export async function fetchPlans(baseUrl, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/plans`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return null;
    return normalizePlans((await response.json())?.plans);
  } catch {
    return null;
  }
}

export function formatPrice(plan) {
  if (plan.monthly == null) return 'see pricing';
  if (plan.monthly === 0) return 'Free';
  return `${plan.currency === 'USD' ? '$' : `${plan.currency} `}${plan.monthly}/month`;
}
