import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import OverlayApp from './overlay/OverlayApp';
import { ErrorBoundary } from './components/ErrorBoundary';

const isOverlay = location.hash === '#/overlay';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{isOverlay ? <OverlayApp /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
