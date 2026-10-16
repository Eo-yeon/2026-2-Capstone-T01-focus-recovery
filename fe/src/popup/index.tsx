import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DevStatus, PopupMessage, Reply } from '../shared/types';
import { validGoal } from '../shared/goal';
import './style.css';
function App() {
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<DevStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestInFlight = useRef(false);
  const [inspect, setInspect] = useState(false);
  async function request(message: PopupMessage) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true); setError('');
    try {
      const reply = await chrome.runtime.sendMessage(message) as Reply;
      if (reply.status) setStatus(reply.status);
      if (!reply.ok) setError(reply.error ?? '요청에 실패했습니다.');
    } catch { setError('요청에 실패했습니다. 입력 목표와 확장 프로그램 상태를 확인해 주세요.'); }
    finally { requestInFlight.current = false; setBusy(false); }
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
    <p>작업 목표는 서버에 전송합니다. 허용한 사이트의 방문·본문·행동 정보는 아직 로컬에만 보관합니다.</p>
    <p>종료는 로컬 수집만 중단합니다. 서버 종료 API는 미연동이므로 서버 세션은 ACTIVE로 남을 수 있습니다.</p>
    <button disabled={busy} onClick={() => void allowSite()}>현재 사이트 수집 허용</button>
    <p>상태: {status?.session ? '서버 세션으로 수집 중' : status?.pendingStart ? '이전 시작 요청 확인 필요' : '수집 중지'}</p>
    {status?.session ? <><p>목표: {status.session.goalText}</p><code>{status.session.sessionId}</code><button disabled={busy} onClick={() => void request({ type: 'stop' })}>로컬 수집 종료</button></> : <>
      <label htmlFor="goal">최초 작업 목표 (현재 BE 구현 기준 5~150자)</label>
      <textarea id="goal" value={status?.pendingStart?.goalText ?? goal} disabled={busy || Boolean(status?.pendingStart)} onChange={event => setGoal(event.target.value)} />
      {status?.pendingStart && <p>서버에 이미 생성되었을 수 있습니다. 목표와 요청 키를 유지해 재시도합니다. 로컬 기록 삭제로 이 요청을 취소할 수 없습니다.</p>}
      <button disabled={busy || !status || !validGoal(status.pendingStart?.goalText ?? goal)} onClick={() => { setInspect(false); void request({ type: 'start', goalText: status?.pendingStart?.goalText ?? goal }); }}>{busy ? '처리 중…' : status?.pendingStart ? '같은 요청 재시도' : '작업 세션 시작'}</button>
    </>}
    {status?.capacityReached && <p role="alert">개발용 200건 한도에 도달해 수집이 중지되었습니다. 종료 후 새 세션을 시작해 주세요.</p>}
    {error && <p role="alert">{error}</p>}
    <p>후보 {status?.candidates.length ?? 0}건 / 유효 방문 {status?.visits.length ?? 0}건</p>
    <button disabled={busy} onClick={() => void request({ type: 'status' })}>상태 새로고침</button>
    <button disabled={busy || Boolean(status?.session)} onClick={() => { setInspect(false); void request({ type: 'clear' }); }}>로컬 기록 삭제</button>
    <label><input type="checkbox" checked={inspect} onChange={event => setInspect(event.target.checked)} /> 수집 데이터 표시 (본문이 화면에 나타납니다)</label>
    {inspect && <pre>{JSON.stringify({ candidates: status?.candidates, visits: status?.visits, readyVisits: status?.readyVisits }, null, 2)}</pre>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
