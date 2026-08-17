// Initial aoife_plan blob — every status honest as of 2026-08-16.
// The weekly template (aoifes_schedule) is NOT touched by seeding.
export function seedPlan() {
  return {
    version: 1,
    year: { label: '2026-27', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { pattern: '7on7off', anchorMonday: '2026-08-17', confirmed: false },
    weeks: {},
    activities: [
      { id: 'core-ruhamah', type: 'ongoing', status: 'active', cat: 'ruhamah', cls: 'r', chain: [] },
      { id: 'core-hala',    type: 'ongoing', status: 'active', cat: 'hala',    cls: 'h', chain: [] },
      { id: 'core-quran',   type: 'ongoing', status: 'active', cat: 'quran',   cls: 'q', chain: [] },
      { id: 'core-art',     type: 'ongoing', status: 'active', cat: 'art',     cls: 'a', chain: [] },
      { id: 'core-mama',    type: 'ongoing', status: 'active', cat: 'barakot', cls: 'b', chain: [] },
      {
        id: 'singapore', name: 'Singapore Math', type: 'paced', status: 'planned',
        cls: 'b', onGrid: false,
        rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
        note: 'Waiting for Dimensions G3 books — activate with real lesson counts',
        chain: [{ id: 'dm3', name: 'Dimensions Math G3', pattern: 'tb-wb',
                  lessons: 0, tests: 0, done: 0 }],
      },
      {
        id: 'loe', name: 'Logic of English', type: 'paced', status: 'active',
        cls: 'b', onGrid: false,
        rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 },
        travel: { mode: 'pause' },
        goal: { finishBy: '2027-08-31' },
        note: 'D span per family info (121-140); publisher may list 121-160 — verify',
        chain: [
          { id: 'loe-c', name: 'Foundations C', pattern: 'simple',
            firstUnit: 81, lastUnit: 120, done: 21, titles: {} },
          { id: 'loe-d', name: 'Foundations D', pattern: 'simple',
            firstUnit: 121, lastUnit: 140, done: 0, titles: {} },
        ],
      },
      {
        id: 'geography', name: 'Geography', type: 'paced', status: 'planned',
        cls: 'g', onGrid: true, slots: [],
        rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' },
        note: '36-week curriculum — unit titles load when the family provides them',
        chain: [{ id: 'geo-1', name: 'Year 1', pattern: 'simple',
                  firstUnit: 1, lastUnit: 36, done: 0, unitWord: 'Week', titles: {} }],
      },
      {
        id: 'science', name: 'Science (Zoom)', type: 'external', status: 'planned',
        cls: 's', onGrid: true, slots: [{ day: 1, start: 14.5, end: 15.5 }],
        ref: 'BFSU Vol 1 — Building Foundations of Scientific Understanding',
        terms: [
          { name: 'Semester 1', start: '2026-09-01', end: '2027-01-31' },
          { name: 'Semester 2', start: '2027-02-08', end: '2027-06-30' },
        ],
        note: 'Not enrolled yet. Tue 2:30-3:30 clashes with Miss Hala Tue 2-3.',
        chain: [],
      },
      {
        id: 'jj', name: 'Jiu Jitsu', type: 'target', status: 'planned',
        cls: 'j', onGrid: true, slots: [], target: 20,
        note: 'Not enrolled yet — target 20/yr is a default, adjust on enrollment',
        chain: [],
      },
      { id: 'history', name: 'History', type: 'paced', status: 'parked',
        cls: 'j', onGrid: false, note: 'Revisit ~Sept 2027', chain: [] },
    ],
    overrides: [],
    log: [{ date: '2026-08-16', activityId: 'loe', curriculum: 'loe-c', session: 20, status: 'done' }],
  };
}
