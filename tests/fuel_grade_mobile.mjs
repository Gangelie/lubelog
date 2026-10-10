// Optional browser check: node tests/fuel_grade_mobile.mjs <base-url> <vehicle-id> [screenshot.png]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [base, vehicleId, screenshot] = process.argv.slice(2);
if (!base || !vehicleId) throw new Error('Expected base URL and vehicle ID');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lubelog-fuel-grade-chrome-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--remote-allow-origins=*', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let socket;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
    if (chrome.exitCode !== null) throw new Error('Chromium exited before opening DevTools');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(portFile)) throw new Error('Chromium did not open DevTools');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 2, mobile: true
  });
  await command('Page.navigate', { url: `${base}/Vehicle/Index?vehicleId=${vehicleId}` });
  const ready = await evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.readyState === 'complete' && typeof showAddGasRecordModal === 'function' &&
          typeof GetVehicleId === 'function' && typeof window.bootstrap?.Tab === 'function') return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  })()`);
  if (!ready) throw new Error('Vehicle page did not load the fuel record script');
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button[data-bs-target="#gas-tab-pane"]')];
    const button = buttons.find(item => item.getClientRects().length) ?? buttons[0];
    if (!button) throw new Error('Fuel tab button is missing');
    bootstrap.Tab.getOrCreateInstance(button).show();
  })()`);
  const visibleTab = await evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('#gas-tab-pane')?.classList.contains('active') &&
          document.querySelector('#gasRecordModal') && window.jQuery?.active === 0) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  })()`);
  if (!visibleTab) {
    const state = await evaluate(`({ tab: document.querySelector('#gas-tab-pane')?.className,
      modal: !!document.querySelector('#gasRecordModal'), activeRequests: window.jQuery?.active,
      title: document.title })`);
    throw new Error(`Fuel tab did not finish loading: ${JSON.stringify(state)}`);
  }
  await evaluate('showAddGasRecordModal()');
  const geometry = await evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      const select = document.querySelector('#gasRecordFuelGrade');
      const modal = document.querySelector('#gasRecordModal');
      if (select && modal?.classList.contains('show')) {
        const rect = select.getBoundingClientRect();
        const tire = document.querySelector('#gasRecordTireSeason').getBoundingClientRect();
        const content = modal.querySelector('.modal-content').getBoundingClientRect();
        return { viewport: innerWidth, selectLeft: rect.left, selectRight: rect.right,
          selectWidth: rect.width, modalLeft: content.left, modalRight: content.right,
          tireLeft: tire.left, tireRight: tire.right, tireWidth: tire.width,
          label: document.querySelector('label[for="gasRecordFuelGrade"]')?.textContent?.trim() };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  })()`);
  if (!geometry) throw new Error('Fuel grade dropdown did not open');
  if (geometry.selectWidth < 200 || geometry.selectLeft < -1 ||
      geometry.selectRight > geometry.viewport + 1 ||
      geometry.selectRight > geometry.modalRight + 1 ||
      geometry.selectLeft < geometry.modalLeft - 1 || !geometry.label ||
      geometry.tireWidth < 200 || geometry.tireLeft < -1 ||
      geometry.tireRight > geometry.viewport + 1 || geometry.tireRight > geometry.modalRight + 1) {
    throw new Error(`Mobile layout failed: ${JSON.stringify(geometry)}`);
  }
  await evaluate(`(async () => {
    hideAddGasRecordModal();
    for (const name of ['fuelgrade', 'tireseason']) {
      const toggle = document.querySelector('#gas-tab-pane [data-column-toggle="' + name + '"]');
      if (!toggle) throw new Error(name + ' column toggle missing');
      toggle.checked = true;
      showTableColumns(toggle, 'GasRecord');
      while (window.jQuery?.active) await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cells = [...document.querySelectorAll('#gas-tab-pane tbody td[data-column="fuelgrade"], #gas-tab-pane tbody td[data-column="tireseason"]')];
    if (!cells.length || cells.some(cell => !cell.getClientRects().length ||
        cell.getBoundingClientRect().right > innerWidth + 1)) throw new Error('Mobile fuel columns overflow or are hidden');
    getVehicleGasRecords(${JSON.stringify(vehicleId)});
    while (window.jQuery?.active) await new Promise(resolve => setTimeout(resolve, 20));
    for (const name of ['fuelgrade', 'tireseason']) {
      const toggle = document.querySelector('#gas-tab-pane [data-column-toggle="' + name + '"]');
      if (!toggle?.checked) throw new Error(name + ' visibility was not restored');
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    showAddGasRecordModal();
    while (window.jQuery?.active) await new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < 50 && !document.querySelector('#gasRecordModal')?.classList.contains('show'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })()`);
  if (screenshot) {
    const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshot, Buffer.from(result.data, 'base64'));
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });
  const desktop = await evaluate(`(() => {
    const rect = document.querySelector('#gasRecordFuelGrade').getBoundingClientRect();
    const tire = document.querySelector('#gasRecordTireSeason').getBoundingClientRect();
    const modal = document.querySelector('#gasRecordModal .modal-content').getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right,
      tireWidth: tire.width, tireLeft: tire.left, tireRight: tire.right,
      modalLeft: modal.left, modalRight: modal.right, viewport: innerWidth };
  })()`);
  if (desktop.width < 200 || desktop.left < desktop.modalLeft - 1 ||
      desktop.right > desktop.modalRight + 1 || desktop.right > desktop.viewport + 1 ||
      desktop.tireWidth < 200 || desktop.tireLeft < desktop.modalLeft - 1 ||
      desktop.tireRight > desktop.modalRight + 1) {
    throw new Error(`Desktop layout failed: ${JSON.stringify(desktop)}`);
  }
  console.log(`PASS: mobile dropdown ${Math.round(geometry.selectWidth)}px at 375px; desktop dropdown ${Math.round(desktop.width)}px at 1280px`);
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  fs.rmSync(profile, { recursive: true, force: true });
}
