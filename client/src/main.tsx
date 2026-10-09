import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

// スタイルは「トークン → 骨格 → 投稿 → 部品 → 画面 → モバイル」の順に読む
import './styles/tokens.css';
import './styles/layout.css';
import './styles/posts.css';
import './styles/post-parts.css';
import './styles/components.css';
import './styles/parts.css';
import './styles/modal.css';
import './styles/views.css';
import './styles/phase4.css';
import './styles/profile.css';
import './styles/settings.css';
import './styles/onboarding.css';
import './styles/mobile.css';

// プッシュ通知の受け口（対応しているブラウザだけ）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // 登録できなくても、他の機能はそのまま使える
    });
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
