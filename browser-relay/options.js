// The options page: the code, the connection's state, Pause, and New code.
const $ = (id) => document.getElementById(id);
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dashed = (key) => key.replace(/(.{4})(?=.)/g, '$1-');

let current = null;
let newKeyArmed = false;

function show(s) {
  current = s;
  $('code').textContent = dashed(s.key);
  $('stores').textContent = s.stores.join(', ');
  $('max').textContent = s.maxSearches;
  $('pause').textContent = s.paused ? 'Resume · استئناف' : 'Pause · إيقاف مؤقت';
  const dot = $('dot');
  let text;
  if (s.paused) {
    dot.className = 'dot wait';
    text = 'Paused · متوقف مؤقتًا';
  } else if (s.connected) {
    dot.className = 'dot on';
    text = 'Connected · متصل';
  } else {
    dot.className = 'dot off';
    text = 'Not connected · غير متصل';
  }
  $('state').textContent = text;
  const lines = [];
  for (const stop of s.stopped) lines.push(`${stop.label} refused a search. Waiting until ${time(stop.until)}.`);
  lines.push(`Searches in the last 10 minutes: ${s.searches}${s.lastSearchAt ? ` · last at ${time(s.lastSearchAt)}` : ''}`);
  $('detail').textContent = lines.join(' ');
}

function ask(message) {
  chrome.runtime.sendMessage(message, (s) => {
    if (s) show(s);
  });
}

$('copy').addEventListener('click', async () => {
  if (!current) return;
  await navigator.clipboard.writeText(dashed(current.key));
  $('copy').textContent = 'Copied · تم النسخ';
  setTimeout(() => ($('copy').textContent = 'Copy · نسخ'), 1500);
});

$('pause').addEventListener('click', () => {
  if (current) ask({ type: 'pause', paused: !current.paused });
});

// A new code cuts off every device that has the old one, so it takes two clicks.
$('newkey').addEventListener('click', () => {
  if (!newKeyArmed) {
    newKeyArmed = true;
    $('newkey').textContent = 'Click again: the old code stops working';
    setTimeout(() => {
      newKeyArmed = false;
      $('newkey').textContent = 'New code · رمز جديد';
    }, 4000);
    return;
  }
  newKeyArmed = false;
  $('newkey').textContent = 'New code · رمز جديد';
  ask({ type: 'new-key' });
});

ask({ type: 'status' });
setInterval(() => ask({ type: 'status' }), 5000);
