'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const [, , browserPath, targetUrl, outputPath, widthValue, heightValue] = process.argv;
const width = Number(widthValue);
const height = Number(heightValue);

if (!browserPath || !targetUrl || !outputPath || !Number.isInteger(width) || !Number.isInteger(height)) {
  throw new Error('Використання: node tests/capture-visual.js <браузер> <URL> <PNG> <ширина> <висота>');
}
if (width < 320 || height < 480) throw new Error('Неприпустимий розмір області перегляду');

const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zientsov-edge-'));
const browser = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDirectory}`,
  'about:blank'
], {stdio: 'ignore', windowsHide: true});

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForFile(filePath, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
    if (browser.exitCode !== null) throw new Error(`Microsoft Edge завершився з кодом ${browser.exitCode}`);
    await delay(50);
  }
  throw new Error(`Не створено службовий файл Microsoft Edge: ${filePath}`);
}

async function openTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, {method: 'PUT'});
  if (!response.ok) throw new Error(`Microsoft Edge DevTools повернув HTTP ${response.status}`);
  return response.json();
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'Помилка DevTools'));
      else request.resolve(message.result || {});
      return;
    }
    const callbacks = listeners.get(message.method) || [];
    listeners.delete(message.method);
    callbacks.forEach(callback => callback(message.params || {}));
  });

  function command(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
    });
  }

  function once(method, timeoutMilliseconds = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Не отримано подію ${method}`)), timeoutMilliseconds);
      const callback = params => { clearTimeout(timer); resolve(params); };
      listeners.set(method, [...(listeners.get(method) || []), callback]);
    });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Не вдалося підключитися до Microsoft Edge DevTools')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve({socket, command, once}); }, {once: true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Помилка з’єднання з Microsoft Edge DevTools')); }, {once: true});
  });
}

async function main() {
  const activePortFile = path.join(profileDirectory, 'DevToolsActivePort');
  await waitForFile(activePortFile);
  const [port] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
  const target = await openTarget(port);
  if (!target.webSocketDebuggerUrl) throw new Error('Microsoft Edge не повернув адресу DevTools');

  const {socket, command, once} = await connect(target.webSocketDebuggerUrl);
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 640,
    screenWidth: width,
    screenHeight: height,
    screenOrientation: {type: 'portraitPrimary', angle: 0}
  });

  const loaded = once('Page.loadEventFired');
  await command('Page.navigate', {url: targetUrl});
  await loaded;
  await command('Runtime.evaluate', {
    expression: 'document.fonts ? document.fonts.ready.then(() => true) : true',
    awaitPromise: true,
    returnByValue: true
  });
  await delay(250);

  const metrics = await command('Runtime.evaluate', {
    expression: '({innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})',
    returnByValue: true
  });
  const values = metrics.result && metrics.result.value;
  if (!values || values.innerWidth !== width || values.innerHeight !== height) {
    throw new Error(`Хибна область перегляду: ${JSON.stringify(values)}`);
  }
  if (values.scrollWidth > width || values.bodyScrollWidth > width) {
    throw new Error(`Горизонтальне обрізання інтерфейсу: ${JSON.stringify(values)}`);
  }

  const screenshot = await command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), {recursive: true});
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
  console.log(`Візуальний тест ${width}×${height}: без горизонтального обрізання`);
  try { await command('Browser.close'); } catch {}
  socket.close();
}

main().finally(async () => {
  if (browser.exitCode === null) browser.kill();
  await delay(300);
  try { fs.rmSync(profileDirectory, {recursive: true, force: true}); } catch {}
}).catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
