import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * 入口（T04）。
 *
 * 直接挂载 App，xterm 与 WS 的实例由组件和 store 的生命周期管理。
 */

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(<App />);
