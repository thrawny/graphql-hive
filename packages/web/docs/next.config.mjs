import nextra from 'nextra';

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.mjs',
  unstable_staticImage: true,
});

export default withNextra({
  swcMinify: true,
  compiler: {
    styledComponents: true,
  },
  output: 'standalone',
});
