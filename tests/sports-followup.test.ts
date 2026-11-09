import { describe, expect, it } from 'vitest';
import { tierOf } from '../server/news/sources.js';
import { decideSearch } from '../server/search/decide.js';
import { mapSerpResponse, sportsSummary } from '../server/search/serpapi.js';
import { decideFor, previousSearched } from '../server/search/web.js';
import type { ChatTurn } from '../server/shared/types.js';

const turns = (...msgs: string[]): ChatTurn[] => msgs.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }) as ChatTurn);

describe('sports questions use the web', () => {
  it('searches for tables, positions, fixtures and results', () => {
    for (const q of [
      'Premier League table',
      'which position is Liverpool',
      'What position is Arsenal in the league?',
      'Where is Liverpool on the log',
      'Liverpool next match',
      'Who won the Chelsea game?',
      'Premier League top scorers',
      'Ghana Premier League standings',
      'Man United transfer news',
    ])
      expect(decideSearch(q).action, q).toBe('search');
  });

  it('does not treat non-sport "position" questions as sport', () => {
    for (const q of ['What position is best for sleeping?', 'Which position should I apply for in a job interview?']) expect(decideSearch(q).action, q).toBe('none');
  });
});

describe('follow-ups keep using the web in a current-events conversation', () => {
  const news = turns('Latest Premier League results', 'Arsenal beat Hull 1-0 ...', 'whiih position iis liverpool]');

  it('detects that the previous message searched', () => {
    expect(previousSearched(news, 'whiih position iis liverpool]')).toBe(true);
    expect(previousSearched(turns('Tell me a joke', 'Why did ...', 'another one'), 'another one')).toBe(false);
  });

  it('searches for a short follow-up, even with typos', () => {
    const d = decideFor('whiih position iis liverpool]', { webSearch: false }, false, false, news);
    expect(d.action).toBe('search');
    expect(d.reason).toBe('follow_up');
  });

  it('does not search for follow-ups about the answer itself or in manual mode', () => {
    const t = turns('Latest Premier League results', '...', 'explain that more simply');
    expect(decideFor('explain that more simply', { webSearch: false }, false, false, t).action).toBe('none');
    expect(decideFor('thanks', { webSearch: false }, false, false, turns('Latest news', '...', 'thanks')).action).toBe('none');
    expect(decideFor('and Chelsea?', { webSearch: false, searchMode: 'manual' }, false, false, turns('Latest Premier League results', '...', 'and Chelsea?')).action).toBe('none');
  });
});

describe("Google's sports panel", () => {
  const panel = {
    title: 'Liverpool',
    rankings: '3rd in Premier League',
    game_spotlight: { league: 'Premier League', date: 'Sat, Nov 8', status: 'FT', teams: [{ name: 'Liverpool', score: 3 }, { name: 'Crystal Palace', score: 1 }] },
    games: [{ tournament: 'Premier League', date: 'Sat, Nov 22', time: '15:00', teams: [{ name: 'Liverpool' }, { name: 'Brighton' }] }],
  };

  it('turns the panel into text the model can use', () => {
    const s = sportsSummary(panel);
    expect(s).toContain('Position: 3rd in Premier League');
    expect(s).toContain('Liverpool 3 - Crystal Palace 1');
    expect(s).toContain('Liverpool - Brighton');
    expect(sportsSummary(undefined)).toBe('');
    expect(sportsSummary({ title: 'Only a title' })).toBe('');
  });

  it('puts the panel first in the search answer', () => {
    const r = mapSerpResponse({ sports_results: panel, organic_results: [{ title: 'Table', link: 'https://www.premierleague.com/tables', snippet: 'x' }] }, 5);
    expect(r.answer).toMatch(/^Google sports panel: Liverpool/);
  });
});

describe('credibility of sports and major outlets', () => {
  it('rates them instead of treating them as unknown', () => {
    expect(tierOf('https://sports.yahoo.com/articles/x.html')).toBe('specialist');
    expect(tierOf('https://www.skysports.com/football/news')).toBe('specialist');
    expect(tierOf('https://www.premierleague.com/tables')).toBe('official');
    expect(tierOf('https://twaslnews1.twaslnews.com/7326997')).toBe('unknown');
  });
});

describe('news keywords ignore instructions about the answer', () => {
  it('keeps only the subject of a long research request', async () => {
    const { detectNews } = await import('../server/news/freshness.js');
    const req = detectNews('Research the latest developments in Ghana’s technology, economy, government and education sectors. Separate confirmed reports from developing stories. tell me more about them, not brief');
    expect(req?.region.id).toBe('ghana');
    expect(req?.keywords).toBe('technology economy government education');
  });
});
