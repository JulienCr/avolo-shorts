import type { Clip } from '@/lib/api'

/** Un clip minimal, complet, pour les tests qui n'ont pas besoin d'un vrai montage. */
export function clipFixture(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c2',
    projectId: 'p1',
    segments: [{ start: 100, end: 120 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    footer: true,
    title: 'La chute',
    description: 'Une impro',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    ...overrides,
  }
}
