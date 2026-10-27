/* ==========================================================
   LCDM · CCB Ⅱ interactive brake display
   Vanilla JavaScript — no dependencies
   ========================================================== */
(() => {
  'use strict';

  const STORAGE_KEY = 'lcdm-ccb2-sim-v2';
  const SETTING_KEYS = ['endMode', 'pipe', 'vehicle', 'feed'];
  const DEFAULTS = Object.freeze({ endMode: 'lead', pipe: 'in', vehicle: 'freight', feed: 'feed' });
  const PRESSURE = { freight: 500, passenger: 600 };
  const PAGE_SIZE = 5;

  const LABELS = {
    endMode: { lead: '本机', helper: '补机' },
    endRole: { lead: '操纵端', helper: '非操纵端' },
    pipe: { in: '投入', cut: '切除' },
    vehicle: { freight: '货车', passenger: '客车' },
    feed: { feed: '补风', nofeed: '不补风' },
    scenario: { initial: '初始', release: '制动缓解', service: '常用制动', emergency: '紧急制动' }
  };

  const EVENT_TONE = { ok: '成功', warn: '提示', info: '记录', danger: '警告' };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const pad = (value) => String(value).padStart(2, '0');
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  let state;
  let pending = null;
  let page = 'main';
  let recordTab = 'events';
  let recordPage = 0;
  let lastFocused = null;
  let gaugeFrame = 0;
  let audioContext = null;
  let toastTimer = 0;
  let clockTimer = 0;
  let persistTimer = 0;

  const sim = { er: 501, bp: 499, mr: 905, bc: 319, flow: 0.92 };
  let simTarget = { ...sim };

  /* ==========================================================
     data
     ========================================================== */

  function makeEvent(title, detail, tone = 'ok', type = 'operation', time = new Date().toISOString()) {
    return { id: uid(), time, type, title, detail, tone };
  }

  function seedEvents() {
    const now = Date.now();
    return [
      makeEvent('CCB Ⅱ 初始化完成', 'ER / BP / MR / BC 传感器自检通过，显示屏通信正常', 'ok', 'system', new Date(now - 52 * 1000).toISOString()),
      makeEvent('列车管压力稳定', 'BP 499 kPa，均衡风缸 501 kPa，系统处于待命状态', 'ok', 'system', new Date(now - 6 * 60 * 1000).toISOString()),
      makeEvent('参数已存储', '本机 · 货车 · 列车管投入 · 补风 · 定压 500 kPa', 'ok', 'store', new Date(now - 38 * 60 * 1000).toISOString()),
      makeEvent('电空制动投入', 'EPCU 通信正常，制动控制单元进入工作状态', 'info', 'system', new Date(now - 2.3 * 60 * 60 * 1000).toISOString()),
      makeEvent('显示屏亮度调整', '自动亮度模式，环境光传感器采样 78%', 'info', 'system', new Date(now - 5.4 * 60 * 60 * 1000).toISOString())
    ];
  }

  function seedFaults() {
    const now = Date.now();
    return [
      {
        id: 'FLT-2031',
        code: 'F-2031',
        severity: 'warn',
        title: '总风压力短时低于 700 kPa',
        detail: '持续 1.8 s，压力恢复后自动清除；建议检查空压机启停间隔与总风管路密封性。',
        time: new Date(now - 27.4 * 60 * 60 * 1000).toISOString(),
        read: false,
        state: '已清除'
      },
      {
        id: 'FLT-0412',
        code: 'I-0412',
        severity: 'info',
        title: '列车管压力传感器零点漂移',
        detail: '偏差 +3.2 kPa，在允许范围内；已完成自动补偿，建议下次定检时复核。',
        time: new Date(now - 76.2 * 60 * 60 * 1000).toISOString(),
        read: false,
        state: '已补偿'
      },
      {
        id: 'FLT-1180',
        code: 'F-1180',
        severity: 'danger',
        title: '制动缸压力传感器信号超时',
        detail: 'BC 通道瞬时无响应 240 ms；重启后恢复，已记录供检修查询。',
        time: new Date(now - 5.2 * 24 * 60 * 60 * 1000).toISOString(),
        read: true,
        state: '已恢复'
      },
      {
        id: 'FLT-0725',
        code: 'I-0725',
        severity: 'info',
        title: 'MVB 总线通信质量下降',
        detail: '瞬时误码率 0.03%，低于告警阈值，通信已自动重连。',
        time: new Date(now - 9.5 * 24 * 60 * 60 * 1000).toISOString(),
        read: true,
        state: '已恢复'
      },
      {
        id: 'FLT-0533',
        code: 'I-0533',
        severity: 'info',
        title: '均衡风缸压力轻微波动',
        detail: '波动范围 ±1.4 kPa，处于正常控制死区内，无需处理。',
        time: new Date(now - 13.8 * 24 * 60 * 60 * 1000).toISOString(),
        read: true,
        state: '已记录'
      }
    ];
  }

  function defaultState() {
    return {
      settings: { ...DEFAULTS },
      brightness: { mode: 'auto', level: 86, ambient: 78 },
      sound: true,
      scenario: 'initial',
      events: seedEvents(),
      faults: seedFaults(),
      storeCount: 1,
      lastStore: new Date(Date.now() - 38 * 60 * 1000).toISOString()
    };
  }

  function validSettings(input) {
    const merged = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
    if (!Object.prototype.hasOwnProperty.call(LABELS.endMode, merged.endMode)) merged.endMode = DEFAULTS.endMode;
    if (!Object.prototype.hasOwnProperty.call(LABELS.pipe, merged.pipe)) merged.pipe = DEFAULTS.pipe;
    if (!Object.prototype.hasOwnProperty.call(LABELS.vehicle, merged.vehicle)) merged.vehicle = DEFAULTS.vehicle;
    if (!Object.prototype.hasOwnProperty.call(LABELS.feed, merged.feed)) merged.feed = DEFAULTS.feed;
    if (merged.endMode === 'helper') merged.pipe = 'cut';
    return merged;
  }

  function loadState() {
    const fallback = defaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return fallback;
      const eventList = Array.isArray(saved.events) && saved.events.length ? saved.events : fallback.events;
      const faultList = Array.isArray(saved.faults) && saved.faults.length ? saved.faults : fallback.faults;
      return {
        settings: validSettings(saved.settings),
        brightness: {
          mode: saved.brightness && saved.brightness.mode === 'manual' ? 'manual' : 'auto',
          level: clamp(Number(saved.brightness && saved.brightness.level) || fallback.brightness.level, 10, 100),
          ambient: clamp(Number(saved.brightness && saved.brightness.ambient) || fallback.brightness.ambient, 0, 100)
        },
        sound: saved.sound !== false,
        scenario: Object.prototype.hasOwnProperty.call(LABELS.scenario, saved.scenario) ? saved.scenario : 'initial',
        events: eventList.map((item) => ({ ...item, id: item.id || uid() })).slice(0, 80),
        faults: faultList.map((item) => ({ ...item, id: item.id || uid(), read: Boolean(item.read) })).slice(0, 40),
        storeCount: clamp(Number(saved.storeCount) || 1, 1, 9999),
        lastStore: saved.lastStore || fallback.lastStore
      };
    } catch (error) {
      return fallback;
    }
  }

  function persist() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          settings: state.settings,
          brightness: state.brightness,
          sound: state.sound,
          scenario: state.scenario,
          events: state.events.slice(0, 80),
          faults: state.faults.slice(0, 40),
          storeCount: state.storeCount,
          lastStore: state.lastStore
        }));
      } catch (error) {
        /* storage can be unavailable in private/kiosk contexts */
      }
    }, 120);
  }

  /* ==========================================================
     helpers
     ========================================================== */

  function activeSettings() { return pending || state.settings; }
  function pressureFor(settings) { return PRESSURE[settings.vehicle] || 500; }
  function settingsEqual(a, b) { return SETTING_KEYS.every((key) => a[key] === b[key]); }
  function isDirty() { return Boolean(pending && !settingsEqual(pending, state.settings)); }
  function changedKeys() { return pending ? SETTING_KEYS.filter((key) => pending[key] !== state.settings[key]) : []; }

  function settingLabel(key, value) {
    if (key === 'endMode') return `${LABELS.endMode[value]} / ${LABELS.endRole[value]}`;
    if (key === 'pipe') return LABELS.pipe[value];
    if (key === 'vehicle') return `${LABELS.vehicle[value]} / ${PRESSURE[value]} kPa`;
    if (key === 'feed') return LABELS.feed[value];
    return value;
  }

  function selectedValueText(key, settings) {
    if (key === 'endMode') return `${LABELS.endMode[settings.endMode]} · ${LABELS.endRole[settings.endMode]}`;
    if (key === 'pipe') return `列车管${LABELS.pipe[settings.pipe]}`;
    if (key === 'vehicle') return `${LABELS.vehicle[settings.vehicle]} · ${PRESSURE[settings.vehicle]} kPa`;
    if (key === 'feed') return settings.feed === 'feed' ? '补风开启' : '不补风';
    return '';
  }

  function settingsSummary(settings) {
    return `${LABELS.endMode[settings.endMode]} · ${LABELS.vehicle[settings.vehicle]} · 列车管${LABELS.pipe[settings.pipe]} · ${LABELS.feed[settings.feed]}`;
  }

  function changeSummary(keys) {
    const list = keys.map((key) => `${key === 'endMode' ? '操纵端' : key === 'pipe' ? '列车管' : key === 'vehicle' ? '车辆' : '补风'} → ${settingLabel(key, pending[key])}`);
    return list.join(' · ');
  }

  function ensurePending() {
    if (!pending) pending = { ...state.settings };
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '----/--/--';
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  }

  function formatFullTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '----';
    return `${formatDate(iso)} ${formatTime(iso)}`;
  }

  /* ==========================================================
     pressure model
     ========================================================== */

  function targetForScenario(scenario, settings) {
    const base = pressureFor(settings);
    if (scenario === 'service') {
      return { er: base, bp: Math.max(0, base - 140), mr: 902, bc: 300, flow: 0.78 };
    }
    if (scenario === 'emergency') {
      return { er: base, bp: 0, mr: 896, bc: 460, flow: 2.42 };
    }
    if (scenario === 'release') {
      const bp = settings.feed === 'nofeed' ? Math.max(0, base - 5) : base;
      return { er: base, bp, mr: 906, bc: 0, flow: settings.feed === 'nofeed' ? 0.54 : 1.46 };
    }
    return { er: 501, bp: 499, mr: 905, bc: 319, flow: 0.92 };
  }

  function startingPressure() {
    if (state.scenario === 'initial' && state.settings.endMode === 'lead' && state.settings.vehicle === 'freight') {
      return { er: 501, bp: 499, mr: 905, bc: 319, flow: 0.92 };
    }
    return targetForScenario(state.scenario === 'initial' ? 'release' : state.scenario, state.settings);
  }

  function gaugeRotation(value) {
    const ratio = clamp(Number(value) / 1400, 0, 1);
    return -135 + ratio * 270;
  }

  function animateGauges(target, duration = 1250) {
    cancelAnimationFrame(gaugeFrame);
    const from = { ...sim };
    const started = performance.now();
    const keys = ['er', 'bp', 'mr', 'bc', 'flow'];
    function step(now) {
      const t = clamp((now - started) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      keys.forEach((key) => { sim[key] = from[key] + (target[key] - from[key]) * eased; });
      paintGauges();
      if (t < 1) gaugeFrame = requestAnimationFrame(step);
      else {
        gaugeFrame = 0;
        Object.assign(sim, target);
        paintGauges();
      }
    }
    gaugeFrame = requestAnimationFrame(step);
  }

  function paintGauges() {
    const er = Math.round(sim.er);
    const bp = Math.round(sim.bp);
    const mr = Math.round(sim.mr);
    const bc = Math.round(sim.bc);
    setText('valER', er); setText('valBP', bp); setText('valMR', mr); setText('valBC', bc);
    setText('trainerER', er); setText('trainerBP', bp); setText('trainerMR', mr); setText('trainerBC', bc);
    const flowValue = sim.flow.toFixed(2);
    setText('flowValue', flowValue);
    const flowFill = byId('flowFill');
    if (flowFill) flowFill.style.height = `${clamp((sim.flow / 2.5) * 100, 0, 100).toFixed(2)}%`;
    const rotations = { er: gaugeRotation(sim.er), bp: gaugeRotation(sim.bp), mr: gaugeRotation(sim.mr), bc: gaugeRotation(sim.bc) };
    Object.entries(rotations).forEach(([key, angle]) => {
      $$(`[data-needle="${key}"]`).forEach((needle) => {
        needle.style.transform = `rotate(${angle.toFixed(2)}deg)`;
      });
    });
  }

  function setText(id, text) {
    const node = byId(id);
    if (node && node.textContent !== String(text)) node.textContent = String(text);
  }

  /* ==========================================================
     clock / brightness / sound
     ========================================================== */

  function updateClock() {
    const now = new Date();
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const date = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
    $$('.loco-clock').forEach((node) => { node.textContent = time; });
    $$('.loco-date').forEach((node) => { node.textContent = date; });
    const headerTime = byId('headerClock');
    if (headerTime) headerTime.textContent = time;
  }

  function autoLevel() {
    return clamp(Math.round(30 + state.brightness.ambient * 0.72), 22, 100);
  }

  function currentBrightness() {
    return state.brightness.mode === 'auto' ? autoLevel() : clamp(state.brightness.level, 10, 100);
  }

  function applyBrightness() {
    const level = currentBrightness();
    state.brightness.level = level;
    const brightness = (0.55 + (level / 100) * 0.5).toFixed(3);
    const dim = (0.48 - (level / 100) * 0.41).toFixed(3);
    document.documentElement.style.setProperty('--screen-brightness', brightness);
    document.documentElement.style.setProperty('--screen-dim', dim);
    const screen = byId('screen');
    if (screen) screen.dataset.brightnessMode = state.brightness.mode;
    const autoKey = $('[data-brightness="auto"]');
    if (autoKey) autoKey.setAttribute('aria-pressed', String(state.brightness.mode === 'auto'));
    $$('.backlight-key').forEach((key) => key.classList.toggle('is-active', state.brightness.mode === 'auto' && key.dataset.brightness === 'auto'));
    const sensor = $('.light-sensor');
    if (sensor) sensor.classList.toggle('is-active', state.brightness.mode === 'auto');
    const autoLamp = byId('autoLamp');
    if (autoLamp) autoLamp.classList.toggle('is-on', state.brightness.mode === 'auto');
    setText('trainerBrightness', `${level}%`);
    setText('trainerBrightnessMode', state.brightness.mode === 'auto' ? '自动亮度' : '手动亮度');
    setText('ambientValue', `${state.brightness.ambient}%`);
    const slider = byId('ambientRange');
    if (slider && document.activeElement !== slider) slider.value = String(state.brightness.ambient);
    const trainerAmbient = byId('trainerAmbient');
    if (trainerAmbient) trainerAmbient.textContent = `${state.brightness.ambient}%`;
  }

  function setBrightness(mode) {
    if (mode === 'up' || mode === 'down') {
      const base = currentBrightness();
      state.brightness.mode = 'manual';
      state.brightness.level = clamp(base + (mode === 'up' ? 5 : -5), 10, 100);
      showToast(mode === 'up' ? '已增亮' : '已减亮', `手动亮度 ${state.brightness.level}%`, 'info', 1400);
    } else {
      state.brightness.mode = 'auto';
      showToast('自动亮度', `环境光 ${state.brightness.ambient}% · 屏幕亮度 ${autoLevel()}%`, 'info', 1700);
    }
    applyBrightness();
    persist();
  }

  function toggleSound() {
    state.sound = !state.sound;
    document.body.classList.toggle('is-muted', !state.sound);
    const button = $('[data-action="toggle-sound"]');
    if (button) button.setAttribute('aria-pressed', String(state.sound));
    if (state.sound) playClick(680);
    showToast(state.sound ? '按键音已开启' : '按键音已关闭', '', 'info', 1400);
    persist();
  }

  function playClick(frequency = 520) {
    if (!state.sound) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioContext) audioContext = new AudioCtx();
      if (audioContext.state === 'suspended') audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
      gain.gain.setValueAtTime(0.028, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.045);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.05);
    } catch (error) {
      /* audio is optional */
    }
  }

  /* ==========================================================
     screen rendering
     ========================================================== */

  function topbar(title, sub) {
    const settings = activeSettings();
    return `
      <header class="lcd-topbar">
        <div class="lcd-brand">
          <i class="lcd-brand__dot"></i>
          <strong>CCB Ⅱ</strong>
          <span>${esc(title)}</span>
          <em>${esc(sub)}</em>
        </div>
        <div class="state-chips">
          <span class="state-chip${settings.endMode === 'helper' ? ' state-chip--warn' : ''}"><i></i><b>${LABELS.endMode[settings.endMode]}</b></span>
          <span class="state-chip"><i></i><b>${LABELS.vehicle[settings.vehicle]} ${PRESSURE[settings.vehicle]}</b></span>
          <span class="state-chip${settings.pipe === 'cut' ? ' state-chip--warn' : ''}"><i></i><b>列车管${LABELS.pipe[settings.pipe]}</b></span>
          <span class="state-chip${settings.feed === 'nofeed' ? ' state-chip--warn' : ''}"><i></i><b>${LABELS.feed[settings.feed]}</b></span>
        </div>
        <div class="loco-meta">
          <span>机车</span><b>08113A</b>
          <span class="loco-clock">${formatTime(new Date().toISOString())}</span>
          <span class="loco-date">${formatDate(new Date().toISOString())}</span>
        </div>
      </header>`;
  }

  function gaugeSVG(kind, options) {
    const cx = 160;
    const cy = 160;
    const start = 135;
    const end = 405;
    const faceId = `gauge-face-${kind}`;
    const ticks = [];
    for (let i = 0; i <= 70; i += 1) {
      const value = i * 20;
      const angle = start + (270 * i) / 70;
      const major = i % 10 === 0;
      const outer = 138;
      const inner = major ? 121 : 129;
      const p1 = polar(cx, cy, outer, angle);
      const p2 = polar(cx, cy, inner, angle);
      ticks.push(`<line class="gauge-tick ${major ? 'gauge-tick--major' : 'gauge-tick--minor'}" x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}"/>`);
      if (major) {
        const labelPosition = polar(cx, cy, 105, angle);
        ticks.push(`<text class="gauge-tick-label" x="${labelPosition.x.toFixed(2)}" y="${labelPosition.y.toFixed(2)}" text-anchor="middle" dominant-baseline="middle">${value}</text>`);
      }
    }
    const whiteRotation = gaugeRotation(options.white);
    const redRotation = gaugeRotation(options.red);
    return `
      <svg class="gauge-svg" viewBox="0 0 320 320" role="img" aria-label="${esc(options.title)}，白针 ${Math.round(options.white)} kPa，红针 ${Math.round(options.red)} kPa">
        <defs>
          <radialGradient id="${faceId}" cx="42%" cy="32%" r="78%">
            <stop offset="0" stop-color="#17231d"/>
            <stop offset="0.54" stop-color="#111a16"/>
            <stop offset="1" stop-color="#080f0d"/>
          </radialGradient>
          <radialGradient id="gauge-rim-${kind}" cx="38%" cy="25%" r="75%">
            <stop offset="0" stop-color="#687a68"/>
            <stop offset="0.52" stop-color="#344034"/>
            <stop offset="1" stop-color="#1a221b"/>
          </radialGradient>
        </defs>
        <circle cx="${cx}" cy="${cy}" r="146" fill="url(#gauge-rim-${kind})" opacity="0.7"/>
        <circle cx="${cx}" cy="${cy}" r="143" fill="url(#${faceId})" stroke="rgba(206,226,204,.3)" stroke-width="0.8"/>
        <path class="gauge-arc" d="${arcPath(cx, cy, 133, start, end)}"/>
        <circle class="gauge-rim-inner" cx="${cx}" cy="${cy}" r="115"/>
        ${ticks.join('')}
        <g class="needle needle--white" data-needle="${options.whiteKey}" style="transform:rotate(${whiteRotation.toFixed(2)}deg)">
          <line x1="${cx}" y1="${cy}" x2="${cx}" y2="50"/>
          <line class="needle-tail" x1="${cx}" y1="${cy}" x2="${cx}" y2="181"/>
        </g>
        <g class="needle needle--red" data-needle="${options.redKey}" style="transform:rotate(${redRotation.toFixed(2)}deg)">
          <line x1="${cx}" y1="${cy}" x2="${cx}" y2="57"/>
          <line class="needle-tail" x1="${cx}" y1="${cy}" x2="${cx}" y2="178"/>
        </g>
        <circle class="gauge-hub-outer" cx="${cx}" cy="${cy}" r="8.5"/>
        <circle class="gauge-hub-inner" cx="${cx}" cy="${cy}" r="4.2"/>
        <circle class="gauge-hub-red" cx="${cx + 3}" cy="${cy - 3}" r="1.7"/>
        <text class="gauge-center-code" x="${cx}" y="203" text-anchor="middle">${esc(options.code)}</text>
        <text class="gauge-center-unit" x="${cx}" y="216" text-anchor="middle">kPa</text>
      </svg>`;
  }

  function polar(cx, cy, radius, degrees) {
    const radians = (degrees * Math.PI) / 180;
    return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
  }

  function arcPath(cx, cy, radius, start, end) {
    const from = polar(cx, cy, radius, start);
    const to = polar(cx, cy, radius, end);
    return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${radius} ${radius} 0 1 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
  }

  function readoutHTML(id, label, dotClass, value) {
    return `
      <div class="readout readout--${dotClass}">
        <span class="readout__label"><i></i>${esc(label)}</span>
        <span class="readout__number"><b id="${id}">${Math.round(value)}</b><small>kPa</small></span>
      </div>`;
  }

  function renderMain() {
    const settings = activeSettings();
    return `
      <div class="lcd-page main-page">
        ${topbar('制动主界面', 'BRAKE HOME')}
        <div class="lcd-main">
          <aside class="telemetry">
            <span class="telemetry__badge">${settings.endMode === 'lead' ? '本机' : '补机'}</span>
            <div class="telemetry__title">流量</div>
            <div class="flow">
              <div class="flow__scale">
                <div class="flow__ticks"></div>
                <div class="flow__numbers"><span>2.5</span><span>2.0</span><span>1.5</span><span>1.0</span><span>0.5</span><span>0</span></div>
              </div>
              <div class="flow__track"><span class="flow__fill" id="flowFill" style="height:${clamp((sim.flow / 2.5) * 100, 0, 100)}%"></span></div>
              <div class="flow__value" id="flowValue">${sim.flow.toFixed(2)}</div>
            </div>
            <div class="telemetry__ep">电空制动</div>
            <div class="telemetry__foot"><span>EP</span><span>CCB2</span></div>
          </aside>

          <section class="dial-panel">
            <div class="dial-heading">
              <span>均衡风缸 / 列车管</span>
              <span class="needle-legend needle-legend--white"><i></i>ER</span>
              <span class="needle-legend needle-legend--red"><i></i>BP</span>
              <span class="dial-heading__code">0 — 1400</span>
            </div>
            <div class="dial-wrap">
              ${gaugeSVG('left', { title: '均衡风缸与列车管压力', code: 'ER / BP', white: sim.er, red: sim.bp, whiteKey: 'er', redKey: 'bp' })}
            </div>
            <div class="dial-readouts">
              ${readoutHTML('valER', '均衡风缸 ER', 'white', sim.er)}
              ${readoutHTML('valBP', '列车管 BP', 'red', sim.bp)}
            </div>
          </section>

          <section class="dial-panel">
            <div class="dial-heading">
              <span>总风缸 / 制动缸</span>
              <span class="needle-legend needle-legend--white"><i></i>MR</span>
              <span class="needle-legend needle-legend--red"><i></i>BC</span>
              <span class="dial-heading__code">0 — 1400</span>
            </div>
            <div class="dial-wrap">
              ${gaugeSVG('right', { title: '总风缸与制动缸压力', code: 'MR / BC', white: sim.mr, red: sim.bc, whiteKey: 'mr', redKey: 'bc' })}
            </div>
            <div class="dial-readouts">
              ${readoutHTML('valMR', '总风缸 MR', 'white', sim.mr)}
              ${readoutHTML('valBC', '制动缸 BC', 'red', sim.bc)}
            </div>
          </section>
        </div>
        <div class="status-strip ${isDirty() ? 'status-strip--pending' : ''}">
          <span class="status-strip__dot"></span>
          ${isDirty()
            ? `<b>参数待执行</b><span>${esc(changeSummary(changedKeys()))}</span><span class="status-strip__right"><kbd>F1</kbd> 执行 <kbd>F8</kbd> 取消</span>`
            : `<b>系统正常</b><span>定压 ${pressureFor(settings)} kPa · 列车管${LABELS.pipe[settings.pipe]} · ${LABELS.feed[settings.feed]} · ${LABELS.scenario[state.scenario]}</span><span class="status-strip__right">EPCU 通信正常</span>`}
        </div>
        <nav class="softkey-labels" aria-label="屏幕软键功能">${softkeyLabelsHTML()}</nav>
      </div>`;
  }

  function renderSettings() {
    const settings = activeSettings();
    const changed = changedKeys();
    return `
      <div class="lcd-page settings-page">
        ${topbar('电空制动设置', 'EP BRAKE SETTINGS')}
        <div class="settings-headbar">
          <h2>电空制动参数</h2>
          <span>EP BRAKE CONFIGURATION</span>
          <div class="settings-headbar__state">
            <i></i>${isDirty() ? `待执行 ${changed.length} 项` : '已生效'} <b>· 定压 ${pressureFor(settings)} kPa</b>
          </div>
        </div>
        <div class="settings-grid">
          ${settingCard('endMode', '01', '操纵端', '本机为操纵端；补机为非操纵端并自动切除列车管。', [
            { value: 'lead', label: '本机 · 操纵端' },
            { value: 'helper', label: '补机 · 非操纵端' }
          ], settings)}
          ${settingCard('pipe', '02', '列车管', '操纵端投入列车管；切除后本端不再控制列车管压力。', [
            { value: 'in', label: '投入' },
            { value: 'cut', label: '切除' }
          ], settings)}
          ${settingCard('vehicle', '03', '车辆模式 / 定压', '货车定压 500 kPa，客车定压 600 kPa；切换后按 F1 生效。', [
            { value: 'freight', label: '货车 · 500 kPa' },
            { value: 'passenger', label: '客车 · 600 kPa' }
          ], settings)}
          ${settingCard('feed', '04', '补风', '补风：列车管漏风时自动补充；不补风：只减压、不自动补风。', [
            { value: 'feed', label: '补风' },
            { value: 'nofeed', label: '不补风' }
          ], settings)}
        </div>
        <div class="settings-summary">
          <span>控制模式 <b>电空制动</b></span>
          <span>定压 <b>${pressureFor(settings)} kPa</b></span>
          <span>操纵端 <b>${LABELS.endMode[settings.endMode]}</b></span>
          <span class="settings-summary__spacer"></span>
          ${isDirty() ? `<span class="settings-summary__pending">待执行 <b>${esc(changeSummary(changed))}</b></span>` : '<span>F4–F7 修改 · F1 执行 · F8 返回</span>'}
        </div>
        <nav class="softkey-labels" aria-label="屏幕软键功能">${softkeyLabelsHTML()}</nav>
      </div>`;
  }

  function settingCard(key, index, title, description, options, settings) {
    const selected = settings[key];
    const changed = Boolean(pending && pending[key] !== state.settings[key]);
    return `
      <article class="setting-card${changed ? ' is-changed' : ''}">
        <div class="setting-card__top">
          <span class="setting-card__index">${index}</span>
          <span class="setting-card__title">${esc(title)}</span>
          <span class="setting-card__tag">待执行</span>
        </div>
        <p class="setting-card__desc">${esc(description)}</p>
        <div class="setting-card__value"><span>当前选择</span><b>${esc(selectedValueText(key, settings))}</b></div>
        <div class="segmented">
          ${options.map((option) => `
            <button type="button" data-setting="${key}" data-value="${option.value}" class="${selected === option.value ? 'is-selected' : ''}" aria-pressed="${selected === option.value}">
              ${esc(option.label)}
            </button>`).join('')}
        </div>
      </article>`;
  }

  function renderRecords() {
    const list = recordTab === 'faults' ? state.faults : state.events;
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    recordPage = clamp(recordPage, 0, pages - 1);
    const pageItems = list.slice(recordPage * PAGE_SIZE, recordPage * PAGE_SIZE + PAGE_SIZE);
    const unread = state.faults.filter((item) => !item.read).length;
    return `
      <div class="lcd-page records-page">
        ${topbar('记录查询', recordTab === 'faults' ? 'FAULT HISTORY' : 'EVENT RECORDS')}
        <div class="records-toolbar">
          <button class="record-tab${recordTab === 'events' ? ' is-active' : ''}" type="button" data-record-tab="events">事件记录 <b>${state.events.length}</b></button>
          <button class="record-tab${recordTab === 'faults' ? ' is-active' : ''}" type="button" data-record-tab="faults">故障履历 <b>${state.faults.length}</b></button>
          <div class="records-toolbar__status">参数存储 <b>${state.storeCount} 次</b>${unread ? ` · 未读故障 <b>${unread}</b>` : ' · 记录完整'}</div>
        </div>
        <div class="records-table">
          <div class="record-head">
            <span>${recordTab === 'faults' ? '故障代码' : '时间'}</span>
            <span>${recordTab === 'faults' ? '故障描述' : '事件内容'}</span>
            <span>${recordTab === 'faults' ? '处理状态' : '结果'}</span>
          </div>
          <div class="record-list">
            ${pageItems.length ? pageItems.map((item) => recordTab === 'faults' ? faultRow(item) : eventRow(item)).join('') : '<div class="records-empty">当前分类暂无记录</div>'}
          </div>
        </div>
        <div class="records-pager">
          <span>第 <b>${recordPage + 1}</b> / ${pages} 页</span>
          <span>共 <b>${list.length}</b> 条记录</span>
          <span class="records-pager__right"><span><kbd>F5</kbd> 上页</span><span><kbd>F6</kbd> 下页</span><span><kbd>F8</kbd> 退出</span></span>
        </div>
        <nav class="softkey-labels" aria-label="屏幕软键功能">${softkeyLabelsHTML()}</nav>
      </div>`;
  }

  function eventRow(item) {
    const date = new Date(item.time);
    return `
      <div class="record-row">
        <div class="record-time">${formatTime(item.time)}<small>${formatDate(item.time)}</small></div>
        <div class="record-main"><strong>${esc(item.title)}</strong><span>${esc(item.detail || '')}</span></div>
        <span class="record-status record-status--${item.tone === 'warn' ? 'warn' : item.tone === 'danger' ? 'danger' : 'ok'}"><i></i>${EVENT_TONE[item.tone] || '记录'}</span>
      </div>`;
  }

  function faultRow(item) {
    const tone = item.severity === 'danger' ? 'danger' : item.severity === 'warn' ? 'warn' : 'info';
    return `
      <div class="record-row record-row--fault">
        <span class="fault-code fault-code--${tone}"><i></i>${esc(item.code)}${item.read ? '' : '<i class="fault-unread" aria-label="未读"></i>'}</span>
        <div class="record-main"><strong>${esc(item.title)}</strong><span>${esc(item.detail || '')}</span></div>
        <span class="record-status record-status--${tone}"><i></i>${esc(item.state || '已记录')}</span>
      </div>`;
  }

  function keyInfo(key) {
    const settings = activeSettings();
    const dirty = isDirty();
    const count = changedKeys().length;
    if (key === 'F1') {
      if (page === 'records') return { text: '返回', sub: '制动主界面' };
      return { text: '执行', sub: dirty ? `${count} 项待执行` : '确认生效', primary: true };
    }
    if (key === 'F2') return { text: '存储', sub: dirty ? '请先执行' : '参数 / 记录' };
    if (key === 'F3') {
      if (page === 'settings') return { text: '默认参数', sub: '恢复初始' };
      if (page === 'records') return { text: '事件记录', sub: `${state.events.length} 条`, active: recordTab === 'events' };
      return { text: '电空制动', sub: '设置菜单' };
    }
    if (page === 'records') {
      if (key === 'F4') return { text: '故障履历', sub: `${state.faults.length} 条`, active: recordTab === 'faults' };
      if (key === 'F5') return { text: '上页', sub: `第 ${recordPage + 1} 页` };
      if (key === 'F6') return { text: '下页', sub: '记录翻页' };
      if (key === 'F7') return { text: recordTab === 'faults' ? '全部已读' : '刷新', sub: recordTab === 'faults' ? '清除未读' : '重新读取' };
      if (key === 'F8') return { text: '退出', sub: '制动主界面' };
    }
    if (key === 'F4') return { text: settings.endMode === 'lead' ? '操纵端' : '非操纵端', sub: settings.endMode === 'lead' ? '本机 · 切换' : '补机 · 切换', pending: dirty && pending.endMode !== state.settings.endMode };
    if (key === 'F5') return { text: LABELS.pipe[settings.pipe], sub: settings.endMode === 'helper' ? '补机联锁' : '列车管 · 切换', pending: dirty && pending.pipe !== state.settings.pipe, locked: settings.endMode === 'helper' };
    if (key === 'F6') return { text: LABELS.vehicle[settings.vehicle], sub: `${PRESSURE[settings.vehicle]} kPa · 切换`, pending: dirty && pending.vehicle !== state.settings.vehicle };
    if (key === 'F7') return { text: LABELS.feed[settings.feed], sub: settings.feed === 'feed' ? '开启 · 切换' : '关闭 · 切换', pending: dirty && pending.feed !== state.settings.feed };
    if (key === 'F8') return { text: '退出', sub: dirty ? '取消修改' : page === 'settings' ? '返回主界面' : '主界面' };
    return { text: key, sub: '' };
  }

  function softkeyLabelsHTML() {
    return ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].map((key) => {
      const info = keyInfo(key);
      const classes = ['screen-key'];
      if (info.primary) classes.push('is-primary');
      if (info.pending) classes.push('is-pending');
      if (info.active) classes.push('is-active');
      if (info.locked) classes.push('is-locked');
      return `<button class="${classes.join(' ')}" type="button" data-screen-key="${key}" aria-label="${esc(key)} ${esc(info.text)} ${esc(info.sub || '')}">
        <span class="screen-key__num">${key}</span>
        <span class="screen-key__text">${esc(info.text)}</span>
        <span class="screen-key__sub">${esc(info.sub || '')}</span>
      </button>`;
    }).join('');
  }

  function renderScreen() {
    const view = byId('screenView');
    if (!view) return;
    if (page === 'settings') view.innerHTML = renderSettings();
    else if (page === 'records') view.innerHTML = renderRecords();
    else view.innerHTML = renderMain();
    requestAnimationFrame(paintGauges);
  }

  function refreshUI() {
    renderScreen();
    renderHeader();
    updateHardwareLabels();
    updateTrainer();
  }

  function renderHeader() {
    const element = byId('headerState');
    if (!element) return;
    const count = changedKeys().length;
    element.textContent = count ? `待执行 ${count} 项` : '系统正常';
    element.style.color = count ? 'var(--amber)' : '';
  }

  function updateHardwareLabels() {
    $$('[data-softkey]').forEach((button) => {
      const key = button.dataset.softkey;
      const info = keyInfo(key);
      button.setAttribute('aria-label', `软键 ${key}：${info.text}${info.sub ? `，${info.sub}` : ''}`);
      button.title = `${key} · ${info.text}${info.sub ? ` · ${info.sub}` : ''}`;
      button.classList.toggle('is-actionable', Boolean(info.primary));
      button.classList.toggle('is-alert', Boolean(info.pending));
    });
  }

  /* ==========================================================
     trainer
     ========================================================== */

  function updateTrainer() {
    const settings = activeSettings();
    setText('trainerER', Math.round(sim.er));
    setText('trainerBP', Math.round(sim.bp));
    setText('trainerMR', Math.round(sim.mr));
    setText('trainerBC', Math.round(sim.bc));
    setText('trainerSettings', `${settingsSummary(settings)} · ${pressureFor(settings)} kPa`);
    setText('trainerBrightness', `${currentBrightness()}%`);
    setText('trainerBrightnessMode', state.brightness.mode === 'auto' ? '自动亮度' : '手动亮度');
    setText('ambientValue', `${state.brightness.ambient}%`);
    const slider = byId('ambientRange');
    if (slider && document.activeElement !== slider) slider.value = String(state.brightness.ambient);
    $$('[data-scenario]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.scenario === state.scenario);
    });
    renderMiniLog();
  }

  function renderMiniLog() {
    const container = byId('miniLog');
    if (!container) return;
    container.innerHTML = state.events.slice(0, 4).map((event) => `
      <li><time>${formatTime(event.time)}</time><span>${esc(event.title)}</span></li>`).join('');
  }

  function addEvent(title, detail, tone = 'ok', type = 'operation') {
    state.events.unshift(makeEvent(title, detail, tone, type));
    state.events = state.events.slice(0, 80);
  }

  /* ==========================================================
     actions
     ========================================================== */

  function startPendingChange(key, value, source = 'key') {
    ensurePending();
    const previous = pending[key];
    if (previous === value) {
      showToast('参数未变化', settingLabel(key, value), 'info', 1400);
      return;
    }
    if (key === 'pipe' && pending.endMode === 'helper' && value === 'in') {
      showToast('补机联锁', '补机 / 非操纵端不允许投入列车管', 'error', 2300);
      return;
    }
    pending[key] = value;
    if (key === 'endMode' && value === 'helper' && pending.pipe !== 'cut') pending.pipe = 'cut';
    playClick(source === 'key' ? 480 : 580);
    const detail = key === 'endMode' && value === 'helper'
      ? '列车管将联锁切除，按 F1 执行'
      : `${settingLabel(key, value)}，按 F1 执行`;
    showToast('待执行修改', detail, 'warn', 2200);
    refreshUI();
  }

  function toggleSetting(key) {
    const current = activeSettings()[key];
    if (key === 'endMode') return startPendingChange('endMode', current === 'lead' ? 'helper' : 'lead');
    if (key === 'pipe') {
      if (activeSettings().endMode === 'helper') {
        showToast('补机联锁', '补机 / 非操纵端列车管已切除，不能投入', 'error', 2400);
        return;
      }
      return startPendingChange('pipe', current === 'in' ? 'cut' : 'in');
    }
    if (key === 'vehicle') return startPendingChange('vehicle', current === 'freight' ? 'passenger' : 'freight');
    if (key === 'feed') return startPendingChange('feed', current === 'feed' ? 'nofeed' : 'feed');
  }

  function commitSettings() {
    if (!isDirty()) {
      showToast('无需执行', '当前设置已经生效', 'info', 1600);
      return;
    }
    if (pending.endMode === 'helper') pending.pipe = 'cut';
    const keys = changedKeys();
    const after = { ...pending };
    const before = { ...state.settings };
    state.settings = after;
    pending = null;
    if (state.scenario === 'initial') state.scenario = 'release';
    const target = targetForScenario(state.scenario, state.settings);
    addEvent('电空制动参数执行', `${keys.map((key) => `${key === 'endMode' ? '操纵端' : key === 'pipe' ? '列车管' : key === 'vehicle' ? '车辆模式' : '补风'}→${settingLabel(key, after[key])}`).join('；')}；定压 ${pressureFor(after)} kPa`, 'ok');
    persist();
    refreshUI();
    requestAnimationFrame(() => animateGauges(target, 1500));
    flashScreen();
    showToast('设置已执行', `${settingsSummary(after)} · 定压 ${pressureFor(after)} kPa`, 'success', 2800);
    announce(`设置已执行。${settingsSummary(after)}，定压 ${pressureFor(after)} 千帕。`);
  }

  function storeParameters() {
    if (isDirty()) {
      showToast('存在未执行修改', '请先按 F1 执行，或按 F8 取消后再存储', 'warn', 2600);
      return;
    }
    state.storeCount += 1;
    state.lastStore = new Date().toISOString();
    addEvent('参数已存储', `存储编号 #${String(state.storeCount).padStart(2, '0')} · ${settingsSummary(state.settings)} · 定压 ${pressureFor(state.settings)} kPa`, 'ok', 'store');
    persist();
    recordTab = 'events';
    recordPage = 0;
    page = 'records';
    syncHash();
    refreshUI();
    showToast('参数已存储', `已写入本机记录，当前共 ${state.storeCount} 次存储`, 'success', 2200);
    announce('参数已存储，已打开事件记录页面。');
  }

  function openRecords(tab = 'events') {
    if (isDirty()) {
      showToast('存在未执行修改', '请先执行或取消当前修改，再查询记录', 'warn', 2500);
      return;
    }
    recordTab = tab;
    recordPage = 0;
    page = 'records';
    syncHash();
    refreshUI();
  }

  function openSettings() {
    page = 'settings';
    syncHash();
    refreshUI();
    showToast('电空制动设置', isDirty() ? `当前有 ${changedKeys().length} 项待执行` : '使用 F4–F7 修改，F1 执行，F8 返回', 'info', 2400);
    announce('已进入电空制动设置。');
  }

  function enterMain() {
    page = 'main';
    syncHash();
    refreshUI();
  }

  function exitCurrent() {
    const dirty = isDirty();
    if (page === 'settings') {
      pending = null;
      enterMain();
      showToast(dirty ? '已取消修改' : '已退出设置', dirty ? '未执行的参数修改已全部放弃' : '返回制动主界面', dirty ? 'warn' : 'info', 2200);
      announce(dirty ? '已取消修改并返回主界面。' : '已返回主界面。');
      return;
    }
    if (page === 'records') {
      enterMain();
      showToast('已退出记录查询', '返回制动主界面', 'info', 1800);
      announce('已返回主界面。');
      return;
    }
    if (dirty) {
      pending = null;
      refreshUI();
      showToast('已取消修改', '未执行的参数修改已全部放弃', 'warn', 2400);
      announce('已取消未执行的修改。');
      return;
    }
    showToast('已在主界面', '按 F3 进入电空制动设置', 'info', 1800);
    flashScreen();
  }

  function resetDefaults() {
    pending = { ...DEFAULTS };
    playClick(620);
    refreshUI();
    showToast('已载入默认参数', '按 F1 执行后生效，F8 取消', 'warn', 2400);
  }

  function triggerSoftkey(key) {
    if (!/^F[1-8]$/.test(key)) return;
    flashHardwareKey(key);
    flashScreenKey(key);
    playClick(430 + Number(key.slice(1)) * 38);
    if (page === 'settings') {
      if (key === 'F1') return commitSettings();
      if (key === 'F2') return storeParameters();
      if (key === 'F3') return resetDefaults();
      if (key === 'F4') return toggleSetting('endMode');
      if (key === 'F5') return toggleSetting('pipe');
      if (key === 'F6') return toggleSetting('vehicle');
      if (key === 'F7') return toggleSetting('feed');
      if (key === 'F8') return exitCurrent();
    }
    if (page === 'records') {
      if (key === 'F1') { enterMain(); showToast('已返回主界面', '', 'info', 1400); return; }
      if (key === 'F2') return storeParameters();
      if (key === 'F3') { recordTab = 'events'; recordPage = 0; syncHash(); refreshUI(); return; }
      if (key === 'F4') { recordTab = 'faults'; recordPage = 0; syncHash(); refreshUI(); return; }
      if (key === 'F5') { recordPage = Math.max(0, recordPage - 1); refreshUI(); return; }
      if (key === 'F6') {
        const total = recordTab === 'faults' ? state.faults.length : state.events.length;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        recordPage = Math.min(pages - 1, recordPage + 1);
        refreshUI();
        return;
      }
      if (key === 'F7') {
        if (recordTab === 'faults') {
          state.faults.forEach((item) => { item.read = true; });
          addEvent('故障履历已读', '故障记录未读标记已全部清除', 'info', 'system');
          persist();
          refreshUI();
          showToast('全部已读', '故障履历中的未读标记已清除', 'success', 1800);
        } else {
          refreshUI();
          showToast('列表已刷新', '事件记录已重新读取', 'info', 1400);
        }
        return;
      }
      if (key === 'F8') return exitCurrent();
    }
    if (key === 'F1') return commitSettings();
    if (key === 'F2') return storeParameters();
    if (key === 'F3') return openSettings();
    if (key === 'F4') return toggleSetting('endMode');
    if (key === 'F5') return toggleSetting('pipe');
    if (key === 'F6') return toggleSetting('vehicle');
    if (key === 'F7') return toggleSetting('feed');
    if (key === 'F8') return exitCurrent();
  }

  function setSettingValue(key, value) {
    if (key === 'pipe' && activeSettings().endMode === 'helper' && value === 'in') {
      showToast('补机联锁', '补机 / 非操纵端不能投入列车管', 'error', 2400);
      return;
    }
    startPendingChange(key, value, 'screen');
  }

  function flashHardwareKey(key) {
    const node = $(`[data-softkey="${key}"]`);
    if (!node) return;
    node.classList.add('is-pressed');
    window.setTimeout(() => node.classList.remove('is-pressed'), 170);
  }

  function flashScreenKey(key) {
    const node = $(`[data-screen-key="${key}"]`);
    if (!node) return;
    node.classList.add('is-pressed');
    window.setTimeout(() => node.classList.remove('is-pressed'), 170);
  }

  function flashScreen() {
    const flash = byId('screenFlash');
    if (!flash) return;
    flash.classList.remove('is-on');
    void flash.offsetWidth;
    flash.classList.add('is-on');
    window.setTimeout(() => flash.classList.remove('is-on'), 560);
  }

  function setScenario(name) {
    if (!Object.prototype.hasOwnProperty.call(LABELS.scenario, name) || name === 'initial') return;
    if (isDirty()) {
      showToast('存在未执行修改', '请先执行或取消修改，再注入工况', 'warn', 2500);
      return;
    }
    state.scenario = name;
    const target = targetForScenario(name, state.settings);
    animateGauges(target, name === 'emergency' ? 900 : 1350);
    addEvent(`工况注入 · ${LABELS.scenario[name]}`, `目标：ER ${target.er} kPa · BP ${target.bp} kPa · BC ${target.bc} kPa`, name === 'emergency' ? 'danger' : name === 'service' ? 'warn' : 'ok', 'scenario');
    persist();
    if (page !== 'main') enterMain();
    else refreshUI();
    updateTrainer();
    showToast(LABELS.scenario[name], `BP ${target.bp} kPa · BC ${target.bc} kPa`, name === 'emergency' ? 'error' : name === 'service' ? 'warn' : 'success', 2400);
    announce(`工况已切换为${LABELS.scenario[name]}。`);
  }

  /* ==========================================================
     modals / overlays
     ========================================================== */

  function openLayer(id) {
    const target = byId(id);
    if (!target) return;
    lastFocused = document.activeElement;
    ['trainerLayer', 'helpLayer', 'resetLayer'].forEach((layerId) => {
      if (layerId === id) return;
      const layer = byId(layerId);
      if (layer) { layer.hidden = true; layer.classList.remove('is-open'); }
    });
    target.hidden = false;
    requestAnimationFrame(() => target.classList.add('is-open'));
    document.body.classList.add('overlay-open');
    window.setTimeout(() => {
      const focusTarget = target.querySelector('.panel-close, .button, button');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }, 240);
  }

  function closeLayer(id) {
    const target = byId(id);
    if (!target || target.hidden) return;
    target.classList.remove('is-open');
    window.setTimeout(() => {
      target.hidden = true;
      document.body.classList.remove('overlay-open');
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus({ preventScroll: true });
    }, 250);
  }

  function closeTopLayer() {
    if (!byId('resetLayer').hidden) return closeLayer('resetLayer');
    if (!byId('helpLayer').hidden) return closeLayer('helpLayer');
    if (!byId('trainerLayer').hidden) return closeLayer('trainerLayer');
    return false;
  }

  function confirmReset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* noop */ }
    state = defaultState();
    pending = null;
    page = 'main';
    recordTab = 'events';
    recordPage = 0;
    Object.assign(sim, startingPressure());
    simTarget = { ...sim };
    closeLayer('resetLayer');
    syncHash();
    updateClock();
    applyBrightness();
    refreshUI();
    paintGauges();
    document.body.classList.toggle('is-muted', !state.sound);
    const soundButton = $('[data-action="toggle-sound"]');
    if (soundButton) soundButton.setAttribute('aria-pressed', String(state.sound));
    showToast('已恢复出厂设置', '参数、工况与记录已重置', 'success', 2600);
    announce('已恢复出厂设置。');
  }

  /* ==========================================================
     navigation / hash
     ========================================================== */

  function syncHash() {
    let hash = '';
    if (page === 'settings') hash = '#settings';
    else if (page === 'records') hash = recordTab === 'faults' ? '#faults' : '#records';
    try {
      if (hash) history.replaceState(null, '', hash);
      else history.replaceState(null, '', location.pathname + location.search);
    } catch (error) {
      /* file URL history can be restricted in some browsers */
    }
  }

  function applyHash() {
    const hash = location.hash.toLowerCase();
    if (hash === '#settings') { page = 'settings'; return; }
    if (hash === '#records' || hash === '#events') { page = 'records'; recordTab = 'events'; return; }
    if (hash === '#faults') { page = 'records'; recordTab = 'faults'; return; }
    page = 'main';
  }

  /* ==========================================================
     toast / announce
     ========================================================== */

  function showToast(title, text = '', type = 'info', duration = 2600) {
    const region = byId('toastRegion');
    if (!region) return;
    while (region.firstChild) region.firstChild.remove();
    const node = document.createElement('div');
    node.className = `toast toast--${type}`;
    const strong = document.createElement('b');
    strong.textContent = title;
    node.appendChild(strong);
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      node.appendChild(span);
    }
    region.appendChild(node);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      node.classList.add('is-out');
      window.setTimeout(() => node.remove(), 190);
    }, duration);
  }

  function announce(message) {
    const node = byId('srStatus');
    if (node) node.textContent = message;
  }

  /* ==========================================================
     events
     ========================================================== */

  function bindEvents() {
    document.addEventListener('click', (event) => {
      const actionTarget = event.target.closest('[data-action]');
      if (actionTarget) {
        const action = actionTarget.dataset.action;
        if (action === 'open-trainer') { playClick(600); openLayer('trainerLayer'); return; }
        if (action === 'close-trainer') { closeLayer('trainerLayer'); return; }
        if (action === 'open-help') { playClick(640); openLayer('helpLayer'); return; }
        if (action === 'close-help') { closeLayer('helpLayer'); return; }
        if (action === 'open-reset') { playClick(360); openLayer('resetLayer'); return; }
        if (action === 'close-reset') { closeLayer('resetLayer'); return; }
        if (action === 'confirm-reset') { confirmReset(); return; }
        if (action === 'toggle-sound') { toggleSound(); return; }
        if (action === 'fullscreen') { toggleFullscreen(); return; }
        if (action === 'open-records') { closeLayer('trainerLayer'); window.setTimeout(() => openRecords('events'), 220); return; }
        if (action === 'home') {
          event.preventDefault();
          pending = null;
          enterMain();
          showToast('已返回主界面', '', 'info', 1200);
          return;
        }
      }

      const softkey = event.target.closest('[data-softkey]');
      if (softkey) { triggerSoftkey(softkey.dataset.softkey); return; }

      const screenKey = event.target.closest('[data-screen-key]');
      if (screenKey) { triggerSoftkey(screenKey.dataset.screenKey); return; }

      const brightness = event.target.closest('[data-brightness]');
      if (brightness) {
        flashBrightnessKey(brightness);
        setBrightness(brightness.dataset.brightness);
        return;
      }

      const setting = event.target.closest('[data-setting]');
      if (setting) { setSettingValue(setting.dataset.setting, setting.dataset.value); return; }

      const tab = event.target.closest('[data-record-tab]');
      if (tab) { recordTab = tab.dataset.recordTab; recordPage = 0; syncHash(); refreshUI(); return; }

      const scenario = event.target.closest('[data-scenario]');
      if (scenario) { setScenario(scenario.dataset.scenario); return; }
    });

    document.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      if (event.key === 'Escape') {
        if (closeTopLayer()) event.preventDefault();
        return;
      }
      const match = /^F([1-8])$/.exec(event.key);
      if (match) {
        event.preventDefault();
        triggerSoftkey(`F${match[1]}`);
        return;
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target;
        if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        event.preventDefault();
        openLayer('helpLayer');
      }
    });

    const ambient = byId('ambientRange');
    if (ambient) {
      ambient.addEventListener('input', (event) => {
        state.brightness.ambient = clamp(Number(event.target.value) || 0, 0, 100);
        if (state.brightness.mode === 'auto') applyBrightness();
        else updateTrainer();
        persist();
      });
    }

    $$('.overlay__backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', () => {
        const layer = backdrop.closest('.overlay');
        if (layer) closeLayer(layer.id);
      });
    });
  }

  function flashBrightnessKey(button) {
    button.classList.add('is-pressed');
    window.setTimeout(() => button.classList.remove('is-pressed'), 150);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {
          showToast('无法进入全屏', '浏览器当前阻止了全屏请求', 'warn', 2200);
        });
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  /* ==========================================================
     boot
     ========================================================== */

  function init() {
    state = loadState();
    applyHash();
    Object.assign(sim, startingPressure());
    simTarget = { ...sim };
    document.body.classList.toggle('is-muted', !state.sound);
    const soundButton = $('[data-action="toggle-sound"]');
    if (soundButton) soundButton.setAttribute('aria-pressed', String(state.sound));
    applyBrightness();
    updateClock();
    refreshUI();
    bindEvents();
    clockTimer = window.setInterval(updateClock, 1000);
    window.setTimeout(() => {
      if (!gaugeFrame) {
        animateGauges({ ...sim, mr: sim.mr + (Math.random() * 2 - 1), flow: sim.flow }, 1600);
      }
    }, 4500);

    window.LCDM = {
      getState: () => ({ page, pending, settings: state.settings, scenario: state.scenario, sim: { ...sim }, brightness: state.brightness }),
      triggerSoftkey,
      setScenario,
      openPage: (name) => {
        if (name === 'settings') openSettings();
        else if (name === 'records') openRecords('events');
        else if (name === 'faults') openRecords('faults');
        else enterMain();
      },
      reset: confirmReset
    };
  }

  init();
})();
