import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Idle Hands',
  description: 'Local-first coding agent CLI',
  base: '/IdleHands/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/commands' },
      { text: 'GitHub', link: 'https://github.com/visorcraft/idlehands' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Setup Wizard', link: '/guide/setup-wizard' },
            { text: 'TUI', link: '/guide/tui' },
            { text: 'Bots', link: '/guide/bots' },
            { text: 'Runtime Orchestration', link: '/guide/runtime' },
            { text: 'Hooks & Plugins', link: '/guide/hooks' },
            { text: 'Trifecta', link: '/guide/trifecta' },
            { text: 'Anton', link: '/guide/anton' },
            { text: 'Headless / CI', link: '/guide/headless' }
          ]
        }
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Commands', link: '/reference/commands' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Config', link: '/reference/config' },
            { text: 'Safety', link: '/reference/safety' },
            { text: 'Features', link: '/reference/features' },
            { text: 'Changelog', link: '/reference/changelog' }
          ]
        }
      ]
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/visorcraft/idlehands' }]
  }
})
