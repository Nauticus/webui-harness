import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './router';
// JetBrains Mono, self-hosted: the app runs on a LAN box, so a CDN font would
// be a request that can fail. Latin and Cyrillic, the three weights we use.
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/cyrillic-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/cyrillic-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/jetbrains-mono/cyrillic-700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>
);
