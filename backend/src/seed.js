/**
 * Apps provisioned on first boot.
 *
 * The description is shown to visitors on the index page, so it is written in
 * the language the landing pages use rather than as an internal note.
 *
 * Adding a product to the platform means adding an entry here (or creating it
 * from the admin panel) and dropping a frontend into `frontend/apps/<slug>/`.
 * Nothing else in the backend changes: routes, numbering, stats and exports
 * are all scoped by slug already.
 *
 * `ensureApps` only creates what is missing, so edits to a name or
 * description here do not overwrite changes made later in the admin panel.
 */
export const SEED_APPS = [
  {
    slug: 'pages',
    name: 'Pages',
    description: '매일 저녁, 하루가 한 페이지의 이야기로 도착해요.',
    // The design asks for a name and an email address, nothing more.
    collectPhone: false,
    requirePhone: false,
    // A hundred-place beta for Samsung Research staff; the page counts up to
    // it and closes the form on arrival.
    capacity: 100,
  },
  {
    slug: 'cdots',
    name: 'C\u00B7Dots',
    description: '신뢰하는 사람들에게 물어보세요.',
    // The landing page asks for an email address and nothing else.
    collectName: false,
    requireName: false,
    collectPhone: false,
    requirePhone: false,
    // A hundred-place beta; the page counts down rather than up.
    capacity: 100,
  },
];

export default SEED_APPS;
