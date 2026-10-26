const status = document.getElementById('status');
const log = document.getElementById('log');
const MaxLogChars = 200_000;

window.dsh.on('launcher:status', (text) => { status.textContent = text; });

window.dsh.on('launcher:log', (line) => {
  log.hidden = false;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent += line + '\n';
  if (log.textContent.length > MaxLogChars) log.textContent = log.textContent.slice(-MaxLogChars / 2);
  if (atBottom) log.scrollTop = log.scrollHeight;
});
