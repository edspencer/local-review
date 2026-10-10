import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadReviewer } from './Comments';
import './styles.css';

// No <StrictMode>: in dev it attaches, detaches and re-attaches every ref callback. @pierre/diffs'
// <FileDiff> creates its renderer in a ref callback, and the second instance finds the first one's
// half-built <pre> in the shadow root, takes it for server-rendered HTML and "hydrates" it instead of
// rendering, so small diffs stayed blank under `npm run dev` (production never double-invokes).
// The reviewer is fetched once, before the first render, so every avatar and Edit button knows whose comments are whose.
loadReviewer().finally(() => createRoot(document.getElementById('root')!).render(<App />));
