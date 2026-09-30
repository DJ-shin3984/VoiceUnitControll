// 실행: node --test tests/regression.test.cjs
// 실제 HTML 스크립트를 실행하고 브라우저·음성·타이머 경계만 모사한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'voice-rts.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function environment() {
  const nodes = new Map(), timers = new Map(), windowEvents = new Map();
  let timerId = 0;
  function element() {
    return {
      checked: true, value: 'end', style: {}, children: [], firstChild: {}, textContent: '',
      classList: { contains() { return false; }, toggle() {} },
      getContext() { return {}; }, addEventListener() {}, append() {}, prepend() {},
    };
  }
  class Recognition {
    start() { this.starts = (this.starts || 0) + 1; }
    stop() { this.stops = (this.stops || 0) + 1; }
    abort() { this.aborted = true; } // 종료 이벤트는 테스트가 원하는 순서에 전달한다.
  }
  const context = vm.createContext({
    assert, console, performance, timers, windowEvents,
    location: { protocol: 'http:' }, navigator: { userAgent: 'Chrome' },
    window: { SpeechRecognition: Recognition, addEventListener(type, handler) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(handler); }, matchMedia: () => ({ addEventListener() {} }) },
    document: {
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      createElement: element, documentElement: {}, body: {},
    },
    getComputedStyle: () => ({ getPropertyValue: () => '', fontFamily: '' }),
    matchMedia: () => ({ addEventListener() {} }),
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    requestAnimationFrame() {},
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source.replace('reset(); resize(); requestAnimationFrame(loop);', 'reset();'), context);
  vm.runInContext(`
    beep = () => {}; showParsed = () => {}; recordLatency = () => {};
    let logs = []; addLog = (...args) => logs.push(args);
    function marine(x = 500){ return spawnUnit('marine', x, 500); }
    function run(text, cursor = {x:800,y:500}){ return execute(parseText(text).cmds, cursor, true); }
    function begin(text){ startPTT(); result(text); }
    function result(text, final = false){
      const row = [{transcript:text}]; row.isFinal = final;
      rec.onresult({results:[row]});
    }
    function finish(text){ result(text, true); stopPTT(); finalize(utter); }
    function space(type, repeat = false){
      const e = {code:'Space',key:' ',repeat,target:{tagName:'BODY'},preventDefault(){}};
      for (const handler of windowEvents.get(type) || []) handler(e);
    }
    function emitTo(recognizer, entries){
      const results = entries.map(([text, final]) => { const row = [{transcript:text}]; row.isFinal = final; return row; });
      recognizer.onresult({results});
    }
    function deferredAI(){
      let resolve, reject;
      sample = { json: () => new Promise((a,b) => { resolve = a; reject = b; }) };
      const promise = handleText(['xyz'], {source:'text',cursor:{x:800,y:500}});
      return {promise, resolve, reject};
    }
    const aiMove = {commands:[{subject:{kind:'selection'},action:'move',target:{kind:'grid',cell:'H5'}}]};
  `, context);
  return code => vm.runInContext(code, context);
}

function check(name, code) {
  test(name, async () => { await environment()(code); });
}

check('기존 수정: 부대 이름 중복 및 없는 숫자·한글 번호', `
  const a = marine(), b = marine(600); assignSquad('독수리',[a]); assignSquad('큰독수리',[b]);
  assert.equal(parseSubject('큰독수리 대기').subject.ids.length,1);
  a.sel = true;
  for (const text of ['9번 부대 대기','9번 대기','구번 대기']) assert.equal(run(text)[0].ok,false);
`);
check('기존 수정: 항목별 생산 수량', `
  assert.equal(parseProduceItems('해병 5명 의무병 생산')[1].count,1);
  assert.equal(parseProduceItems('해병 5명 의무병 2명 생산')[1].count,2);
`);
check('구역 발음과 조사 인식', `
  for (const [text,cell] of [['에이원 쪽으로 이동','A1'],['B2 구역에 이동','B2'],['헤이원 이동','A1'],['에이찌 쓰리 방향으로 이동','H3']]) assert.equal(findGrid(text),cell);
`);
for (const action of ['이동','진격','순찰']) {
  check('목적지 생략 시 발화 종료 커서: ' + action, `
    const a = marine(); a.sel = true; cursorWorld = {x:300,y:300}; begin('선택 ${action}');
    cursorWorld = {x:1000,y:700}; finish('선택 ${action}');
    assert.equal(a.order.x,1000); assert.equal(a.order.y,700);
  `);
}
check('발화 시작 커서는 조기 실행부터 반영', `
  const a = marine(); a.sel = true; $('#optCursor').value = 'start';
  cursorWorld = {x:200,y:200}; startPTT(); cursorWorld = {x:700,y:700}; result('선택 저기 이동');
  assert.equal(a.order.x,200); finish('선택 저기 이동'); assert.equal(a.order.x,200);
`);
check('초기화 전 중간 결과 및 늦은 이벤트 폐기', `
  begin('병영 B2 건설'); const old = rec, oldUtter = utter;
  reset(); old.onresult({results:[]}); old.onend(); finalize(oldUtter);
  assert.equal(rec,null); assert.equal(recState,'off');
  startPTT(); assert.equal(uttResults(utter).length,0); assert.equal(buildings.length,1);
`);
check('확정 대기 중 초기화 후 늦은 종료 이벤트가 마이크를 다시 켜지 않음', `
  startPTT(); recState = 'on'; stopPTT(); utter.done = true;
  const old = rec; reset(); old.onend();
  assert.equal(old.aborted,true); assert.equal(rec,null); assert.equal(recState,'off');
  for (const timer of [...timers.values()]) timer.fn();
  assert.equal(rec,null);
`);
check('초기화 후 새 인식기에도 이전 종료 이벤트가 간섭하지 않음', `
  startPTT(); const old = rec; reset(); startPTT(); const current = rec;
  old.onend(); assert.equal(rec,current); assert.equal(recState,'starting');
`);
check('일반 인식 종료는 누르는 동안 재시작', `
  startPTT(); const current = rec; current.onend();
  assert.notEqual(rec,current); assert.equal(rec.starts,1); assert.equal(recState,'starting');
`);
check('로컬 모델 오류 후 다음 발화는 서버 인식기로 전환', `
  localSR = 'available'; $('#optEngine').value = 'local'; startPTT(); const old = rec;
  old.onerror({error:'language-not-supported'}); old.onend();
  assert.equal(rec,null); assert.equal(utter.done,true);
  startPTT(); assert.equal(recState,'starting'); assert.equal(rec.processLocally,undefined);
`);
check('실패한 조기 명령은 정상 명령의 취소 이력을 보존', `
  const a = marine(); a.sel = true; run('선택 이동');
  begin('선택 공격'); result('선택 거수 공격'); finish('선택 거수 공격');
  assert.equal(undoStack.length,1); assert.equal(run('취소')[0].ok,true); assert.equal(a.order.kind,'idle');
`);
check('실패한 조기 명령의 최종 기록도 실패', `
  const a = marine(); a.sel = true; begin('선택 공격'); finish('선택 공격');
  assert.equal(logs.at(-1)[2],false); assert.equal(undoStack.length,0);
`);
check('성공한 조기 명령은 확정 시 중복 적용하지 않음', `
  const a = marine(); a.sel = true; begin('선택 대기'); finish('선택 대기');
  assert.equal(undoStack.length,1); assert.equal(logs.at(-1)[2],true);
`);
check('다른 부대 마우스 명령과 그 취소 이력을 보존', `
  const a = marine(), b = marine(600); assignSquad('독수리',[a]); assignSquad('망치',[b]);
  begin('독수리 대기'); run('망치 이동',{x:1200,y:500}); result('독수리 정지');
  assert.equal(b.order.x,1200); assert.equal(undoStack.length,2);
  run('취소'); assert.equal(b.order.x,1200);
  run('취소'); assert.equal(b.order.kind,'idle');
`);
check('같은 유닛의 더 최근 명령을 음성 보정이 덮어쓰지 않음', `
  const a = marine(); a.sel = true; begin('선택 대기'); run('선택 이동',{x:1200,y:500});
  result('선택 정지'); finish('선택 정지'); assert.equal(a.order.x,1200);
  run('취소'); assert.equal(a.order.kind,'idle'); assert.equal(undoStack.length,0);
`);
check('사용자의 취소 명령도 더 최근 입력으로 보호', `
  const a = marine(); a.sel = true; begin('선택 대기'); run('취소');
  result('선택 이동'); finish('선택 이동'); assert.equal(a.order.kind,'idle'); assert.equal(undoStack.length,0);
`);
check('늦게 확정된 음성 취소가 더 최근 마우스 명령을 취소하지 않음', `
  const a = marine(); a.sel = true; begin('선택 대기'); run('선택 이동',{x:1200,y:500});
  finish('취소'); assert.equal(a.order.x,1200); assert.equal(undoStack.length,1);
  assert.equal(logs.at(-1)[2],false);
`);
check('빈 중간 결과는 조기 명령을 즉시 복원', `
  const a = marine(); a.sel = true; begin('선택 대기'); result('');
  assert.equal(a.order.kind,'idle'); assert.equal(undoStack.length,0);
`);
check('최종 결과가 명령이 아니면 조기 실행 복원', `
  const a = marine(); a.sel = true; begin('선택 대기'); finish('xyz');
  assert.equal(a.order.kind,'idle'); assert.equal(undoStack.length,0);
`);
check('빈 최종 결과도 조기 실행 복원', `
  const a = marine(); a.sel = true; begin('선택 대기'); utter.results = []; finalize(utter);
  assert.equal(a.order.kind,'idle'); assert.equal(undoStack.length,0);
`);
check('일반 명령 연속 취소와 같은 입력 안의 이동 후 취소', `
  const a = marine(); a.sel = true; run('선택 대기'); run('선택 이동'); run('취소');
  assert.equal(a.order.kind,'hold'); run('취소'); assert.equal(a.order.kind,'idle');
  run('선택 이동; 취소'); assert.equal(a.order.kind,'idle'); assert.equal(undoStack.length,0);
`);
check('늦은 AI 응답은 최근 명령을 덮어쓰지 않음', `(async()=>{
  const a = marine(); a.sel = true; const old = deferredAI(); run('선택 대기');
  old.resolve(aiMove); await old.promise; assert.equal(a.order.kind,'hold');
})()`);
check('초기화 전 AI 응답은 새 게임에 적용하지 않음', `(async()=>{
  const a = marine(); a.sel = true; const old = deferredAI(); reset();
  const b = marine(); b.sel = true; old.resolve(aiMove); await old.promise; assert.equal(b.order.kind,'idle');
})()`);
check('초기화 전 AI 오류는 새 상태나 기능을 훼손하지 않음', `(async()=>{
  const old = deferredAI(); reset(); const activeSample = sample; setStatus('새 상태');
  old.reject({code:'not_granted'}); await old.promise;
  assert.equal(sample,activeSample); assert.equal($('#voiceStatus').textContent,'새 상태');
})()`);
check('새 AI 요청은 이전 요청의 응답과 종료 처리에 영향받지 않음', `(async()=>{
  const a = marine(); a.sel = true; const old = deferredAI(), current = deferredAI();
  old.resolve(aiMove); await old.promise; assert.equal(a.order.kind,'idle'); assert.notEqual(pendingAI,null);
  current.resolve(aiMove); await current.promise; assert.equal(a.order.x,1500); assert.equal(pendingAI,null);
})()`);
check('AI 응답은 요청 당시 선택한 유닛에 적용', `(async()=>{
  const a = marine(), b = marine(600); a.sel = true; const request = deferredAI();
  a.sel = false; b.sel = true; request.resolve(aiMove); await request.promise;
  assert.equal(a.order.x,1500); assert.equal(b.order.kind,'idle');
})()`);

check('연속 스페이스 입력: 첫 발화가 미확정이어도 두 명령을 합치지 않음', `
  const a = marine(), b = marine(600); assignSquad('독수리',[a]); assignSquad('망치',[b]);
  space('keydown'); const firstRec = rec;
  emitTo(firstRec, [['독수리 H5 이동',false]]); space('keyup');
  space('keydown'); const secondRec = rec;
  emitTo(firstRec, [['독수리 H5 이동',true]]);
  assert.equal(uttResults(utter).length,0,'이전 발화의 결과가 새 발화에 들어오면 안 됨');
  emitTo(secondRec, [['망치 B1 이동',true]]); space('keyup'); secondRec.onend();
  assert.equal(a.order.x,1500); assert.equal(a.order.y,900);
  assert.equal(b.order.x,300); assert.equal(b.order.y,100);
  assert.equal(logs.length,2); assert.equal(logs[0][0],'독수리 H5 이동'); assert.equal(logs[1][0],'망치 B1 이동');
`);
check('확정 완료 후 키를 누르지 않은 구간의 음성은 다음 명령에 들어오지 않음', `
  const a = marine(); a.sel = true; space('keydown'); const old = rec;
  emitTo(old,[['선택 H5 이동',true]]); space('keyup'); finalize(utter);
  emitTo(old,[['선택 H5 이동',true],['전군 대기',false]]);
  space('keydown'); assert.equal(uttResults(utter).length,0);
  const current = rec; result('선택 B1 이동',true); space('keyup'); current.onend();
  assert.equal(a.order.x,300); assert.equal(a.order.y,100); assert.equal(logs.at(-1)[0],'선택 B1 이동');
`);
check('같은 부대의 두 번째 명령 이후 첫 발화의 지연 결과가 되살아나지 않음', `
  const a = marine(); a.sel = true; space('keydown'); const first = rec;
  result('선택 H5 이동'); space('keyup'); space('keydown');
  result('선택 B1 이동',true); const second = rec; space('keyup'); second.onend();
  emitTo(first,[['선택 H5 이동',true]]); first.onend();
  assert.equal(a.order.x,300); assert.equal(a.order.y,100); assert.equal(logs.length,2);
`);
check('이전 발화의 확정 타이머가 두 번째 발화를 종료하지 않음', `
  const a = marine(); a.sel = true; space('keydown'); result('선택 H5 이동'); space('keyup');
  const oldTimers = [...timers.values()]; space('keydown'); result('선택 B1 이동'); const second = utter, secondRec = rec;
  for (const timer of oldTimers) timer.fn();
  assert.equal(utter,second); assert.equal(utter.done,false); assert.equal(rec,secondRec);
  space('keyup'); secondRec.onend(); assert.equal(a.order.x,300);
`);
check('두 번째 입력이 무음이면 이전 명령을 다시 실행하지 않음', `
  const a = marine(); a.sel = true; begin('선택 H5 이동'); space('keyup');
  space('keydown'); space('keyup'); rec.onend();
  assert.equal(logs.length,1); assert.equal(undoStack.length,1); assert.equal(a.order.x,1500);
`);
check('키를 뗀 뒤 늦게 온 확정 결과는 해당 발화에 한 번만 적용', `
  $('#optFast').checked = false; const a = marine(); a.sel = true;
  space('keydown'); const recording = rec; result('선택 H5 이동'); space('keyup');
  assert.equal(recording.stops,1); assert.equal(a.order.kind,'idle');
  emitTo(recording,[['선택 H5 이동',true]]); recording.onend();
  assert.equal(a.order.x,1500); assert.equal(logs.length,1); assert.equal(rec,null);
`);
check('확정 대기 타임아웃 후 다음 입력에 늦은 결과가 넘어가지 않음', `
  const a = marine(); a.sel = true; begin('선택 H5 이동'); const first = rec; space('keyup');
  for (const timer of [...timers.values()]) timer.fn();
  assert.equal(utter.done,true); space('keydown'); const second = rec;
  emitTo(first,[['선택 H5 이동',true]]); first.onend(); assert.equal(uttResults(utter).length,0);
  emitTo(second,[['선택 B1 이동',true]]); space('keyup'); assert.equal(a.order.x,300);
`);
check('길게 누를 때 키 반복은 새로운 명령을 만들지 않음', `
  space('keydown'); const owner = utter, recording = rec;
  space('keydown',true); space('keydown',true);
  assert.equal(utter,owner); assert.equal(rec,recording); assert.equal(recording.starts,1);
`);
check('생산 명령 연속 입력은 각 수량을 한 번씩만 예약', `
  run('병영 B2 건설'); space('keydown'); const first = rec;
  result('해병 5명 생산'); space('keyup'); space('keydown'); const second = rec;
  emitTo(first,[['해병 5명 생산',true]]);
  emitTo(second,[['해병 3명 생산',true]]); space('keyup'); first.onend(); second.onend();
  assert.equal(buildings.find(b=>b.bt==='barracks').queue.length,8); assert.equal(logs.length,2);
`);
check('누르는 도중 인식이 종료되어도 같은 발화의 문장은 이어지고 다음 발화와는 분리', `
  const a = marine(); assignSquad('독수리',[a]); space('keydown'); const first = rec;
  result('독수리',true); first.onend(); result('H5 이동',true); space('keyup');
  assert.equal(a.order.x,1500); assert.equal(logs.at(-1)[0],'독수리 H5 이동');
  space('keydown'); assert.equal(uttResults(utter).length,0);
`);
