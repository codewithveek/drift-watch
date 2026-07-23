import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/** Shared nav config between the home layout and the docs layout. */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: 'DriftWatch',
  },
  links: [
    {
      text: 'Documentation',
      url: '/docs',
    },
    {
      text: 'GitHub',
      url: 'https://github.com/codewithveek/drift-watch',
      external: true,
    },
  ],
};
