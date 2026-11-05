export function sportTheme(name = '') {
  const themes = [
    [/羽毛/, 'badminton', 'BADMINTON', '#d6f54a'],
    [/乒乓/, 'pingpong', 'TABLE TENNIS', '#ffa0b6'],
    [/篮球/, 'basketball', 'BASKETBALL', '#ff9859'],
    [/网球/, 'tennis', 'TENNIS', '#b8e875'],
    [/足球/, 'football', 'FOOTBALL', '#81cbb0'],
    [/排球/, 'volleyball', 'VOLLEYBALL', '#b8a2f5'],
    [/游泳/, 'swimming', 'SWIMMING', '#79cdeb'],
  ]
  const match = themes.find(([pattern]) => pattern.test(name))
  return match ? { kind: match[1], label: match[2], color: match[3] } : { kind: 'fitness', label: 'LET’S PLAY', color: '#a9b8d5' }
}
