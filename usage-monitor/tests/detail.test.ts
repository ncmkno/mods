import { expect, test } from 'claude-code/testing'

import { toolDetail } from '../hooks/report'

test('picks the field that says what the call did', () => {
  expect(toolDetail({ tool: 'Bash', command: 'npm test', description: 'Run tests' })).toBe('npm test')
  expect(toolDetail({ tool: 'Read', file_path: '/Users/me/project/src/app.ts' })).toBe('/Users/me/project/src/app.ts')
  expect(toolDetail({ tool: 'Grep', pattern: 'TODO', path: 'src' })).toBe('TODO')
  expect(toolDetail({ tool: 'WebFetch', url: 'https://example.com/a', prompt: 'summarise' })).toBe('https://example.com/a')
  expect(toolDetail({ tool: 'Agent', description: 'Find routes', prompt: 'long prompt' })).toBe('Find routes')
})

test('nothing to summarise gives no detail', () => {
  expect(toolDetail({ tool: 'TodoWrite', todos: [] })).toBeUndefined()
  expect(toolDetail({ tool: 'Bash', command: '   ' })).toBeUndefined()
})

test('collapses whitespace and cuts long input to 160 characters', () => {
  expect(toolDetail({ tool: 'Bash', command: 'cd a &&\n\n   ls   -la' })).toBe('cd a && ls -la')
  const long = toolDetail({ tool: 'Bash', command: 'echo '.repeat(100) })!
  expect(long.length).toBe(160)
  expect(long.endsWith('…')).toBe(true)
})

test('redacts secrets: key=value pairs, bearer tokens and long token-like strings', () => {
  expect(toolDetail({ tool: 'Bash', command: 'API_KEY=abc123 npm run deploy' })).toBe('API_KEY=… npm run deploy')
  expect(toolDetail({ tool: 'Bash', command: 'mysql --password "hunter 2" -u root' })).toBe('mysql --password … -u root')
  expect(toolDetail({ tool: 'Bash', command: 'curl -H "Authorization: Bearer eyJhbGciOi.x.y" api' })).toBe(
    'curl -H "Authorization: …" api',
  )
  expect(toolDetail({ tool: 'Bash', command: 'gh auth login --with-token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' })).toBe(
    'gh auth login --with-token …',
  )
  // a long path is not mistaken for a token
  expect(toolDetail({ tool: 'Read', file_path: '/Users/a10011347/workspace/kino/loanshark/src/game/reef.ts' })).toBe(
    '/Users/a10011347/workspace/kino/loanshark/src/game/reef.ts',
  )
})
