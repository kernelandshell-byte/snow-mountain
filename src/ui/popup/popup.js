import { MSG } from '../../shared/messages.js';

const stats = await chrome.runtime.sendMessage({ type: MSG.STATS }).catch(() => null);
const el = document.getElementById('status');
el.textContent = stats?.ready
  ? stats.docCount + ' pages indexed'
  : 'Storage layer not built yet (build order step 3).';
