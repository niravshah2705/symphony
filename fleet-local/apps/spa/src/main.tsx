import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// The chat look, in load order: the library's standalone stylesheet (class rules
// only, scoped under `.aui-root`), then our token bridge for it, then the app
// stylesheet — so a later house rule can always adjust the chat, never the reverse.
import '@assistant-ui/react-ui/styles/index.css';
import '@assistant-ui/react-ui/styles/markdown.css';
import './assistant-ui/ui/aui-theme.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);