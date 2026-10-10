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
        const tire = document.querySelector('.gas-mobile-tire-picker').getBoundingClientRect();
        const nativeTire = document.querySelector('#gasRecordTireSeason');
        const content = modal.querySelector('.modal-content').getBoundingClientRect();
        const footer = modal.querySelector('.modal-footer').getBoundingClientRect();
        return { viewport: innerWidth, selectLeft: rect.left, selectRight: rect.right,
          selectWidth: rect.width, modalLeft: content.left, modalRight: content.right,
          tireLeft: tire.left, tireRight: tire.right, tireWidth: tire.width,
          nativeTireHidden: getComputedStyle(nativeTire).display === 'none',
          footerVisible: footer.width > 0 && footer.height > 0,
          detailsInitiallyHidden: !document.querySelector('.gas-mobile-notes').getClientRects().length,
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
      geometry.tireRight > geometry.viewport + 1 || geometry.tireRight > geometry.modalRight + 1 ||
      !geometry.nativeTireHidden || !geometry.footerVisible || !geometry.detailsInitiallyHidden) {
    throw new Error(`Mobile layout failed: ${JSON.stringify(geometry)}`);
  }
  const mobileForm = await evaluate(`(() => {
    const modal = document.querySelector('#gasRecordModal');
    const field = id => document.getElementById(id);
    const date = field('gasRecordDate').getBoundingClientRect();
    const mileage = field('gasRecordMileage').getBoundingClientRect();
    const quantity = field('gasRecordGallons').getBoundingClientRect();
    const cost = field('gasRecordCost').getBoundingClientRect();
    const mileageLabel = modal.querySelector('label[for="gasRecordMileage"]');
    const quantityLabel = modal.querySelector('label[for="gasRecordGallons"]');
    const details = modal.querySelector('[data-gas-mobile-details-toggle]');
    const notes = field('gasRecordNotes');
    field('gasRecordGallons').value = '';
    const invalid = getAndValidateGasRecordValues();
    const quantityMarked = field('gasRecordGallons').classList.contains('is-invalid');
    field('gasRecordDate').value = '2026-09-01';
    field('gasRecordMileage').value = '54321';
    field('gasRecordGallons').value = '40';
    field('gasRecordCost').value = '2.50';
    field('gasCostType').value = 'unit';
    field('gasRecordFuelGrade').value = 'E10';
    document.querySelector('#gasMobileTireWinter').click();
    const winter = field('gasRecordTireSeason').value;
    modal.querySelector('.gas-mobile-season-clear').click();
    const cleared = field('gasRecordTireSeason').value === '' &&
      modal.querySelector('.gas-mobile-season-clear').getAttribute('aria-pressed') === 'true';
    document.querySelector('#gasMobileTireWinter').click();
    details.click();
    const detailsOpen = details.getAttribute('aria-expanded') === 'true' && notes.getClientRects().length > 0 &&
      modal.querySelector('.gas-mobile-extra a[onclick="showSuppliesModal()"]').getClientRects().length > 0 &&
      modal.querySelector('.gas-mobile-notes .lubelogger-uploader').getClientRects().length > 0;
    const footerWhenExpanded = modal.querySelector('.modal-footer').getBoundingClientRect();
    notes.value = 'Mobile fuel form check';
    $('#gasRecordTag').append(new Option('mobile-test', 'mobile-test', true, true)).trigger('change');
    details.click();
    const values = getAndValidateGasRecordValues();
    return { dateWidth: date.width, mileageWidth: mileage.width, quantityWidth: quantity.width,
      costWidth: cost.width, viewport: innerWidth, dateRight: date.right, costRight: cost.right,
      mileageLabelOverflow: mileageLabel.scrollWidth > mileageLabel.clientWidth + 1,
      quantityLabelOverflow: quantityLabel.scrollWidth > quantityLabel.clientWidth + 1,
      invalid: invalid.hasError, quantityMarked, winter, cleared, detailsOpen,
      footerWhenExpandedVisible: footerWhenExpanded.top < innerHeight && footerWhenExpanded.bottom > 0,
      detailsClosed: details.getAttribute('aria-expanded') === 'false',
      valid: !values.hasError, total: globalParseFloat(values.cost), grade: values.fuelGrade,
      season: values.tireSeason, notes: values.notes, tags: values.tags };
  })()`);
  if (!mobileForm.invalid || !mobileForm.quantityMarked || !mobileForm.valid ||
      mobileForm.winter !== 'Winter' || !mobileForm.cleared || !mobileForm.detailsOpen ||
      !mobileForm.footerWhenExpandedVisible ||
      !mobileForm.detailsClosed || mobileForm.total !== 100 || mobileForm.grade !== 'E10' ||
      mobileForm.season !== 'Winter' || mobileForm.notes !== 'Mobile fuel form check' ||
      !mobileForm.tags.includes('mobile-test') || mobileForm.dateWidth < 280 ||
      mobileForm.mileageWidth < 100 || mobileForm.quantityWidth < 100 ||
      mobileForm.costWidth < 200 || mobileForm.dateRight > mobileForm.viewport + 1 ||
      mobileForm.costRight > mobileForm.viewport + 1 ||
      mobileForm.mileageLabelOverflow || mobileForm.quantityLabelOverflow) {
    throw new Error(`Mobile fuel form failed: ${JSON.stringify(mobileForm)}`);
  }
  const requiredExtra = await evaluate(`(() => {
    const modal = document.querySelector('#gasRecordModal');
    const extra = document.createElement('div');
    extra.className = 'extra-field';
    extra.innerHTML = '<label>Required browser test</label><input class="extra-field-required" value="">';
    modal.querySelector('.gas-mobile-extra').appendChild(extra);
    saveGasRecordToVehicle();
    const result = { expanded: modal.querySelector('[data-gas-mobile-details-toggle]').getAttribute('aria-expanded'),
      invalid: extra.querySelector('input').classList.contains('is-invalid'),
      focused: document.activeElement === extra.querySelector('input') };
    extra.remove();
    toggleGasMobileDetails(false);
    return result;
  })()`);
  if (requiredExtra.expanded !== 'true' || !requiredExtra.invalid || !requiredExtra.focused) {
    throw new Error(`Hidden required field validation failed: ${JSON.stringify(requiredExtra)}`);
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 700, deviceScaleFactor: 2, mobile: true
  });
  const narrowMobile = await evaluate(`(() => {
    const modal = document.querySelector('#gasRecordModal');
    const content = modal.querySelector('.modal-content').getBoundingClientRect();
    const cost = document.querySelector('#gasRecordCost').getBoundingClientRect();
    const mileage = document.querySelector('#gasRecordMileage').getBoundingClientRect();
    const quantity = document.querySelector('#gasRecordGallons').getBoundingClientRect();
    const back = modal.querySelector('.gas-mobile-back').getBoundingClientRect();
    const save = modal.querySelector('.gas-mobile-header-save').getBoundingClientRect();
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      contentRight: content.right, costRight: cost.right,
      mileageWidth: mileage.width, quantityWidth: quantity.width,
      backWidth: back.width, backHeight: back.height, saveWidth: save.width, saveHeight: save.height };
  })()`);
  if (narrowMobile.scrollWidth > narrowMobile.viewport + 1 ||
      narrowMobile.contentRight > narrowMobile.viewport + 1 ||
      narrowMobile.costRight > narrowMobile.viewport + 1 ||
      narrowMobile.mileageWidth < 200 || narrowMobile.quantityWidth < 200 ||
      Math.min(narrowMobile.backWidth, narrowMobile.backHeight,
               narrowMobile.saveWidth, narrowMobile.saveHeight) < 43) {
    throw new Error(`Narrow mobile layout failed: ${JSON.stringify(narrowMobile)}`);
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 2, mobile: true
  });
  const savedId = await evaluate(`(async () => {
    saveGasRecordToVehicle();
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (window.jQuery?.active) continue;
      const records = await (await fetch('/api/vehicle/gasrecords?vehicleId=${vehicleId}')).json();
      const record = records.find(item => item.notes === 'Mobile fuel form check');
      if (record) {
        if (record.fuelGrade !== 'E10' || record.tireSeason !== 'Winter' ||
            Number(record.cost) !== 100 || Number(record.fuelConsumed) !== 40 ||
            Number(record.odometer) !== 54321 || !record.tags.includes('mobile-test')) {
          throw new Error('Mobile save lost form values: ' + JSON.stringify(record));
        }
        return record.id;
      }
    }
    throw new Error('Mobile fuel record did not save');
  })()`);
  const edited = await evaluate(`(async () => {
    showEditGasRecordModal(${JSON.stringify(savedId)});
    for (let i = 0; i < 100; i++) {
      const modal = document.querySelector('#gasRecordModal');
      if (modal?.classList.contains('show') && document.querySelector('#gasRecordMileage')?.value === '54321') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const modal = document.querySelector('#gasRecordModal');
    const original = { grade: document.querySelector('#gasRecordFuelGrade').value,
      season: document.querySelector('#gasRecordTireSeason').value,
      radio: document.querySelector('#gasMobileTireWinter').checked,
      deleteVisible: modal.querySelector('.modal-footer .btn-danger').getClientRects().length > 0 };
    document.querySelector('#gasRecordMileage').value = '54322';
    document.querySelector('#gasRecordGallons').value = '50';
    document.querySelector('#gasRecordCost').value = '125';
    document.querySelector('#gasRecordFuelGrade').value = 'Super 95';
    document.querySelector('#gasMobileTireSummer').click();
    toggleGasMobileDetails(true);
    document.querySelector('#gasRecordNotes').value = 'Mobile fuel form edited';
    saveGasRecordToVehicle(true);
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (window.jQuery?.active) continue;
      const records = await (await fetch('/api/vehicle/gasrecords?vehicleId=${vehicleId}')).json();
      const record = records.find(item => item.id === ${JSON.stringify(savedId)});
      if (record?.notes === 'Mobile fuel form edited') {
        return { ...original, updated: record };
      }
    }
    throw new Error('Mobile fuel record did not update');
  })()`);
  if (edited.grade !== 'E10' || edited.season !== 'Winter' || !edited.radio || !edited.deleteVisible ||
      edited.updated.fuelGrade !== 'Super 95' || edited.updated.tireSeason !== 'Summer' ||
      Number(edited.updated.cost) !== 125 || Number(edited.updated.fuelConsumed) !== 50 ||
      Number(edited.updated.odometer) !== 54322 || !edited.updated.tags.includes('mobile-test')) {
    throw new Error(`Mobile fuel edit failed: ${JSON.stringify(edited)}`);
  }
  const bulkEdit = await evaluate(`(async () => {
    const records = await (await fetch('/api/vehicle/gasrecords?vehicleId=${vehicleId}')).json();
    const otherId = records.find(record => record.id !== ${JSON.stringify(savedId)})?.id;
    if (!otherId) throw new Error('Bulk edit needs another fuel record');
    editMultipleGasRecords([${JSON.stringify(savedId)}, otherId]);
    for (let i = 0; i < 100; i++) {
      const modal = document.querySelector('#gasRecordModal');
      if (modal?.classList.contains('show') && modal.querySelector('.modal-title')?.textContent.includes('Edit Multiple')) {
        return { singleRecordLayout: modal.classList.contains('gas-mobile-entry'),
          footerVisible: modal.querySelector('.modal-footer').getClientRects().length > 0,
          saveVisible: modal.querySelector('.modal-footer .btn-primary').getClientRects().length > 0 };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Bulk edit modal did not open');
  })()`);
  if (bulkEdit.singleRecordLayout || !bulkEdit.footerVisible || !bulkEdit.saveVisible) {
    throw new Error(`Bulk edit controls were hidden: ${JSON.stringify(bulkEdit)}`);
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
    for (const name of ['cost', 'unitcost']) {
      const moneyCells = [...document.querySelectorAll('#gas-tab-pane tbody td[data-column="' + name + '"]')];
      if (moneyCells.some(cell => cell.scrollWidth > cell.clientWidth + 1)) {
        throw new Error('Mobile ' + name + ' value is clipped');
      }
    }
    const table = document.querySelector('#gas-tab-pane .gas-record-table');
    const container = document.querySelector('#gas-tab-pane .vehicleDetailTabContainer');
    table.classList.remove('ll-responsive-table');
    if (container.scrollWidth <= container.clientWidth) {
      throw new Error('Mobile grid layout cannot scroll horizontally');
    }
    table.classList.add('ll-responsive-table');
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
  const reopened = await evaluate(`(() => {
    const modal = document.querySelector('#gasRecordModal');
    const body = modal.querySelector('.modal-body');
    return { modalScroll: modal.scrollTop, bodyScroll: body.scrollTop, windowScroll: scrollY,
      dateTop: document.querySelector('#gasRecordDate').getBoundingClientRect().top,
      headerBottom: modal.querySelector('.modal-header').getBoundingClientRect().bottom };
  })()`);
  if (reopened.dateTop < reopened.headerBottom || reopened.dateTop > 600) {
    throw new Error(`Reopened fuel form did not start at the top: ${JSON.stringify(reopened)}`);
  }
  if (screenshot) {
    await new Promise(resolve => setTimeout(resolve, 3000));
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
      modalLeft: modal.left, modalRight: modal.right, modalWidth: modal.width,
      notesVisible: document.querySelector('#gasRecordNotes').getClientRects().length > 0,
      footerVisible: document.querySelector('#gasRecordModal .modal-footer').getClientRects().length > 0,
      mobileSaveHidden: !document.querySelector('.gas-mobile-header-save').getClientRects().length,
      viewport: innerWidth };
  })()`);
  if (desktop.width < 200 || desktop.left < desktop.modalLeft - 1 ||
      desktop.right > desktop.modalRight + 1 || desktop.right > desktop.viewport + 1 ||
      desktop.tireWidth < 200 || desktop.tireLeft < desktop.modalLeft - 1 ||
      desktop.tireRight > desktop.modalRight + 1 || desktop.modalWidth > 900 ||
      !desktop.notesVisible || !desktop.footerVisible || !desktop.mobileSaveHidden) {
    throw new Error(`Desktop layout failed: ${JSON.stringify(desktop)}`);
  }
  const columns = await evaluate(`(() => {
    const table = document.querySelector('#gas-tab-pane .gas-record-table');
    const widths = {};
    for (const name of ['daterefueled', 'odometer', 'consumption', 'fueleconomy',
                        'cost', 'unitcost', 'fuelgrade', 'tireseason']) {
      const header = table.querySelector('thead [data-column="' + name + '"]');
      const cells = [...table.querySelectorAll('tbody td[data-column="' + name + '"]')];
      const longest = cells.reduce((a, b) => a.textContent.length >= b.textContent.length ? a : b);
      widths[name] = { header: header.getBoundingClientRect().width,
        cell: longest.getBoundingClientRect().width, scroll: longest.scrollWidth,
        client: longest.clientWidth, text: longest.textContent.trim() };
    }
    return widths;
  })()`);
  if (columns.fueleconomy.header >= 145 ||
      columns.fueleconomy.header >= columns.cost.header ||
      columns.fueleconomy.header >= columns.unitcost.header ||
      ['cost', 'unitcost'].some(name => columns[name].scroll > columns[name].client + 1) ||
      Object.values(columns).some(column => Math.abs(column.header - column.cell) > 1)) {
    throw new Error(`Fuel table column sizing failed: ${JSON.stringify(columns)}`);
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 800, deviceScaleFactor: 1, mobile: false
  });
  const narrowDesktop = await evaluate(`(() => {
    const container = document.querySelector('#gas-tab-pane .vehicleDetailTabContainer');
    return { client: container.clientWidth, scroll: container.scrollWidth };
  })()`);
  if (narrowDesktop.scroll <= narrowDesktop.client) {
    throw new Error(`Narrow desktop did not allow horizontal scrolling: ${JSON.stringify(narrowDesktop)}`);
  }
  console.log(`PASS: mobile dropdown ${Math.round(geometry.selectWidth)}px at 375px; desktop dropdown ${Math.round(desktop.width)}px at 1280px`);
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  fs.rmSync(profile, { recursive: true, force: true });
}
