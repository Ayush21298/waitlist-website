/**
 * Apps provisioned on first boot.
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
    description: 'Your day, delivered as a single page each evening.',
    collectPhone: true,
    requirePhone: false,
  },
];

export default SEED_APPS;
