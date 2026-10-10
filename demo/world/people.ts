// The fictional team behind "Orchard", a booking app for fitness studios. Every name, email and URL in the demo is
// made up; emails use the reserved .example domain and GitHub URLs a made-up org.
import type { Person } from '../lib/gitworld.ts';

export const maya: Person = { name: 'Maya Okafor', email: 'maya@orchard.example' };
export const theo: Person = { name: 'Theo Lindqvist', email: 'theo@orchard.example' };
export const sam: Person = { name: 'Sam Reyes', email: 'sam@orchard.example' };
export const june: Person = { name: 'June Park', email: 'june@orchard.example' };

/** The Local Review user the demo runs as (LOCAL_REVIEW_USER): the reviewer's comments are `author: maya`. */
export const REVIEWER = 'maya';

export const ORG = 'orchard-studio-demo';
export const remote = (repo: string) => `git@github.com:${ORG}/${repo}.git`;
export const prUrl = (repo: string, n: number) => `https://github.com/${ORG}/${repo}/pull/${n}`;

/** "2026-09-14 10:02" → an ISO UTC timestamp. */
export const at = (s: string) => `${s.replace(' ', 'T')}:00Z`;

/**
 * "Now" for the demo: the capture rig freezes the browser clock here, so relative times ("2 days ago") are the same
 * in every screenshot, and the seed sets file times relative to it.
 */
export const DEMO_NOW = '2026-09-18T16:30:00Z';
