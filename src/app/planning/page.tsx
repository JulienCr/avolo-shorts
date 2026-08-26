'use client'

import { PlanningScreen } from '@/components/planning/planning-screen'

/**
 * La route `/planning`, réduite à ce qu'une route doit faire.
 *
 * Même règle que `src/app/settings/page.tsx` : tout est dans `PlanningScreen`,
 * montable sans cette route sous jsdom.
 */
export default function PlanningPage() {
  return <PlanningScreen />
}
