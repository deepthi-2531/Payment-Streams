import { defineConfig } from 'vitepress';

// Docs portal served at /docs/ next to the dashboard. Dark/emerald theme in
// .vitepress/theme/custom.css mirrors the packages/dashboard tokens.

export default defineConfig({
  title: 'Canton Payment Streams — Docs',
  description:
    'Continuous payment streaming for Canton — Daml templates, TypeScript SDK, REST proxy, executor, and dashboard. Architecture, security, operations, and integration guides.',
  lang: 'en-US',

  // Served under a sub-path next to the dashboard.
  base: '/docs/',

  // Dark by default to match the dashboard; the theme toggle stays available.
  appearance: 'dark',
  cleanUrls: false,
  lastUpdated: true,

  // Many docs link to repo source files (../packages, ../config, ../.github,
  // ../docker, ../scripts) that aren't part of this portal — don't fail on them.
  ignoreDeadLinks: true,

  // docs/reports/* are gitignored (kept out of the public repo) — never build
  // or publish them, even though the markdown is present in the tree.
  srcExclude: ['reports/**'],

  // Serve the integration guide index at /integration-guide/.
  rewrites: {
    'integration-guide/README.md': 'integration-guide/index.md',
  },

  markdown: {
    languageAlias: { env: 'ini', dotenv: 'ini', hocon: 'ini', daml: 'haskell' },
  },

  head: [
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap',
      },
    ],
    ['meta', { name: 'theme-color', content: '#07080b' }],
  ],

  themeConfig: {
    siteTitle: 'Canton Streams',
    // Overview is the effective home — logo/title click lands there.
    // logoLink is used verbatim (base is not auto-prepended), so include it.
    logoLink: '/docs/overview.html',

    nav: [
      { text: 'Overview', link: '/overview' },
      {
        text: 'Architecture',
        items: [
          { text: 'System Architecture', link: '/ARCHITECTURE' },
          { text: 'Streaming Settlement Design', link: '/SETTLEMENT-DESIGN' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Get started', link: '/QUICKSTART' },
          { text: 'Integration Guide', link: '/integration-guide/' },
          { text: 'REST API', link: '/API' },
          { text: 'Walkthroughs', link: '/WALKTHROUGHS' },
        ],
      },
      {
        text: 'Operate',
        items: [
          { text: 'Deployment', link: '/DEPLOYMENT' },
          { text: 'Operations Runbook', link: '/OPERATIONS' },
          { text: 'Threat Model', link: '/THREAT-MODEL' },
        ],
      },
      { text: 'Changelog', link: '/changelog' },
    ],

    sidebar: [
      {
        text: 'Overview',
        collapsed: false,
        items: [
          { text: 'Project Overview', link: '/overview' },
          { text: 'Get started', link: '/QUICKSTART' },
          { text: 'Support & Maintenance', link: '/SUPPORT' },
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
          { text: 'Code of Conduct', link: '/code-of-conduct' },
        ],
      },
      {
        text: 'Architecture',
        collapsed: false,
        items: [
          { text: 'System Architecture', link: '/ARCHITECTURE' },
          { text: 'Streaming Settlement Design', link: '/SETTLEMENT-DESIGN' },
        ],
      },
      {
        text: 'Security',
        collapsed: false,
        items: [
          { text: 'Threat Model', link: '/THREAT-MODEL' },
          { text: 'Security Findings', link: '/SECURITY-FINDINGS' },
          { text: 'Audit Scope', link: '/AUDIT-SCOPE' },
        ],
      },
      {
        text: 'Operations & Deployment',
        collapsed: false,
        items: [
          { text: 'Deployment Guide', link: '/DEPLOYMENT' },
          { text: 'Operations Runbook', link: '/OPERATIONS' },
          { text: 'Wallet-Backed E2E Harness', link: '/E2E-HARNESS' },
          { text: 'V1 Lane Testing', link: '/V1-LANE-TESTING' },
        ],
      },
      {
        text: 'Integration Guide',
        collapsed: false,
        items: [
          { text: 'Guide Overview', link: '/integration-guide/' },
          { text: 'Streams Integration', link: '/integration-guide/streams-integration' },
          { text: 'AllocationRequest Pattern', link: '/integration-guide/allocation-request-pattern' },
          { text: 'Non-prefunded Flow (StreamFlow)', link: '/integration-guide/non-prefunded-flow' },
          { text: 'CIP-103 Conformance', link: '/integration-guide/cip-103-conformance' },
          { text: 'Host-Wallet Onboarding', link: '/integration-guide/host-wallet-onboarding' },
          { text: 'Per-Asset Configuration', link: '/integration-guide/per-asset-config' },
          { text: 'CIP-56 V2 Type Reference', link: '/integration-guide/cip-56-v2-types-reference' },
          { text: 'Featured-App Rewards', link: '/integration-guide/featured-app-rewards' },
        ],
      },
      {
        text: 'API & Examples',
        collapsed: false,
        items: [
          { text: 'REST API Reference', link: '/API' },
          { text: 'Integration Example', link: '/INTEGRATION-EXAMPLE' },
          { text: 'Walkthroughs', link: '/WALKTHROUGHS' },
        ],
      },
      {
        text: 'Validation & Reports',
        collapsed: false,
        items: [
          { text: 'USDCx Field Validation', link: '/validation/usdcx-field-validation' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: {
      prev: true,
      next: true,
    },

    darkModeSwitchLabel: 'Theme',
    sidebarMenuLabel: 'Docs',
    returnToTopLabel: 'Top',

    footer: {
      message: 'Canton Payment Streams — Apache-2.0. Continuous payment streaming on the Canton Network.',
      copyright: 'Reference stack: Daml templates · TypeScript SDK · REST proxy · executor · dashboard',
    },
  },
});
