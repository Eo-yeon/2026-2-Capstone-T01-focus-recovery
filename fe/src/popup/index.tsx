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
  const recovery = status?.sessionStartRecovery;
  const pending = recovery?.kind === 'pending' ? recovery : undefined;
  const invalid = recovery?.kind === 'invalid' ? recovery : undefined;
  const delivery = status?.visitDelivery;
  const unconfirmed = delivery?.visits.filter(visit => visit.phase !== 'acked') ?? [];
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
    <p>작업 목표와 허용한 사이트의 확정된 방문·본문·초기 행동 정보를 설정된 API 서버에 전송합니다.</p>
    <p>종료는 로컬 수집만 중단합니다. 서버 종료 API는 미연동이므로 서버 세션은 ACTIVE로 남을 수 있습니다.</p>
    <button disabled={busy} onClick={() => void allowSite()}>현재 사이트 수집 허용</button>
    <p>상태: {status?.session ? '서버 세션으로 수집 중' : invalid ? '시작 요청 복구 필요' : pending ? '이전 시작 요청 확인 필요' : '수집 중지'}</p>
    {invalid && <div role="alert">
      <p>{invalid.reason === 'initialization-failed' ? '저장된 상태를 확인할 수 없습니다. 확장 프로그램과 저장소 상태를 확인한 뒤 Worker를 재시작해 주세요.'
        : invalid.reason === 'missing-request' ? '서버 세션은 확인되지만 생성 요청 키가 없습니다. 중복 생성을 막기 위해 새 작업 시작을 차단했습니다.'
        : '저장된 시작 요청이 손상되었거나 다른 세션 정보와 일치하지 않습니다. 중복 생성을 막기 위해 새 작업 시작을 차단했습니다.'}</p>
      {invalid.sessionId && <p>확인할 서버 세션: <code>{invalid.sessionId}</code></p>}
      <p>원본 저장 정보는 보존했습니다. 담당자와 기존 API 서버의 키·세션 상태를 확인해 주세요. 요청을 지우거나 새 키로 우회하지 마세요. 자동 초기화·수동 복구 UI는 아직 제공하지 않습니다. 로컬 기록 삭제로 이 문제는 해결되지 않습니다.</p>
    </div>}
    {pending?.blockedReason && <p role="alert">{pending.blockedReason === 'server-changed' ? '이전 요청과 API 서버 설정이 다릅니다. 기존 서버 설정으로 되돌린 뒤 같은 요청을 재시도해 주세요.' : '기존 서버 세션이 이미 종료되었습니다. 담당자와 서버 상태를 확인해 주세요. 자동 초기화 기능은 제공하지 않습니다.'}</p>}
    {status?.session ? <><p>목표: {status.session.goalText}</p><code>{status.session.sessionId}</code><button disabled={busy} onClick={() => void request({ type: 'stop' })}>로컬 수집 종료</button></> : <>
      <label htmlFor="goal">최초 작업 목표 (현재 BE 구현 기준 5~150자)</label>
      <textarea id="goal" value={pending?.goalText ?? goal} disabled={busy || Boolean(pending) || Boolean(invalid)} onChange={event => setGoal(event.target.value)} />
      {pending && <p>서버에 이미 생성되었을 수 있습니다. 목표와 요청 키를 유지해 재시도합니다. 로컬 기록 삭제로 이 요청을 취소할 수 없습니다.</p>}
      <button disabled={busy || !status || Boolean(invalid) || Boolean(pending?.blockedReason) || !validGoal(pending?.goalText ?? goal)} onClick={() => { setInspect(false); void request({ type: 'start', goalText: pending?.goalText ?? goal }); }}>{busy ? '처리 중…' : pending ? '같은 요청 재시도' : '작업 세션 시작'}</button>
    </>}
    {status?.capacityReached && <p role="alert">개발용 200건 한도에 도달해 수집이 중지되었습니다. 종료 후 새 세션을 시작해 주세요.</p>}
    {error && <p role="alert">{error}</p>}
    <p>후보 {status?.candidates.length ?? 0}건 / 유효 방문 {status?.visits.length ?? 0}건</p>
    <p>서버 저장 확인 {delivery?.visits.filter(visit => visit.phase === 'acked').length ?? 0}건 / 저장 미확인 {unconfirmed.length}건. 유효 방문 중 순서 미확정 방문은 아직 전송하지 않습니다.</p>
    <p>전송 상태는 브라우저 재시작·확장 재로드 시 유실될 수 있습니다. 로컬 수집 종료 후에도 확정 방문 전송은 계속됩니다.</p>
    {delivery?.blocked && <p role="alert">{delivery.blocked}</p>}
    {unconfirmed.map(visit => <p key={visit.visitId} role={visit.error ? 'alert' : undefined}>방문 #{visit.sequence}: {visit.phase} (시도 {visit.attempts}회){visit.error && ` — ${visit.code ? `${visit.code}: ` : ''}${visit.error}`}</p>)}
    <button disabled={busy || !unconfirmed.some(visit => visit.phase === 'failed' && visit.retryable)} onClick={() => void request({ type: 'retry-visits' })}>같은 방문 재시도</button>
    <button disabled={busy} onClick={() => void request({ type: 'status' })}>상태 새로고침</button>
    <button disabled={busy || Boolean(status?.session)} onClick={() => { setInspect(false); void request({ type: 'clear' }); }}>로컬 기록 삭제</button>
    {unconfirmed.length > 0 && <p>로컬 기록 삭제는 저장 미확인 요청도 버립니다. 진행 중 요청은 서버에 저장될 수 있으며 서버 기록은 삭제되지 않습니다.</p>}
    <label><input type="checkbox" checked={inspect} onChange={event => setInspect(event.target.checked)} /> 수집 데이터 표시 (본문이 화면에 나타납니다)</label>
    {inspect && <pre>{JSON.stringify({ candidates: status?.candidates, visits: status?.visits, readyVisits: status?.readyVisits }, null, 2)}</pre>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
