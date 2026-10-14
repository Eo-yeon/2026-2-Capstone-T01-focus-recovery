import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DevStatus, PopupMessage, Reply } from '../shared/types';
import './style.css';
function App() {
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<DevStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState(false);
  async function request(message: PopupMessage) {
    setBusy(true); setError('');
    try {
      const reply = await chrome.runtime.sendMessage(message) as Reply;
      if (!reply.ok) throw new Error(reply.error ?? '요청에 실패했습니다.');
      if (reply.status) setStatus(reply.status);
    } catch { setError('요청에 실패했습니다. 입력 목표와 확장 프로그램 상태를 확인해 주세요.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void request({ type: 'status' }); }, []);
  async function allowSite() {
    setBusy(true); setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) throw new Error();
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) { setError('사이트 수집 권한이 허용되지 않았습니다.'); return; }
      await request({ type: 'sync-permissions' });
    } catch { setError('일반 HTTP(S) 페이지에서 확장 프로그램을 열어 주세요.'); }
    finally { setBusy(false); }
  }
  return <main>
    <h1>Focus Recovery 개발용 수집기</h1>
    <p>허용한 사이트의 공개 문서만 로컬에서 수집합니다. 서버에 전송하지 않습니다.</p>
    <button disabled={busy} onClick={() => void allowSite()}>현재 사이트 수집 허용</button>
    <p>상태: {status?.session ? '활성 로컬 세션' : '수집 중지'}</p>
    {status?.session ? <><p>목표: {status.session.goalText}</p><code>{status.session.sessionId}</code><button disabled={busy} onClick={() => void request({ type: 'stop' })}>세션 종료</button></> : <>
      <label htmlFor="goal">최초 작업 목표 (현재 BE 구현 기준 5~150자)</label>
      <textarea id="goal" value={goal} maxLength={150} onChange={event => setGoal(event.target.value)} />
      <button disabled={busy || goal.trim().length < 5} onClick={() => { setInspect(false); void request({ type: 'start', goalText: goal }); }}>로컬 세션 시작</button>
    </>}
    {status?.capacityReached && <p role="alert">개발용 200건 한도에 도달해 수집이 중지되었습니다. 종료 후 새 세션을 시작해 주세요.</p>}
    {error && <p role="alert">{error}</p>}
    <p>후보 {status?.candidates.length ?? 0}건 / 유효 방문 {status?.visits.length ?? 0}건</p>
    <button disabled={busy} onClick={() => void request({ type: 'status' })}>상태 새로고침</button>
    <button disabled={busy || Boolean(status?.session)} onClick={() => { setInspect(false); void request({ type: 'clear' }); }}>로컬 기록 삭제</button>
    <label><input type="checkbox" checked={inspect} onChange={event => setInspect(event.target.checked)} /> 수집 데이터 표시 (본문이 화면에 나타납니다)</label>
    {inspect && <pre>{JSON.stringify({ candidates: status?.candidates, visits: status?.visits }, null, 2)}</pre>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
