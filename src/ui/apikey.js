const $ = (id) => document.getElementById(id);
const key = $('key'), error = $('error'), save = $('save'), skip = $('skip');

$('link').addEventListener('click', (e) => { e.preventDefault(); window.dsh.send('open:keys-page'); });
$('show').addEventListener('change', (e) => { key.type = e.target.checked ? 'text' : 'password'; });
skip.addEventListener('click', () => window.dsh.send('apikey:skip'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !skip.disabled) window.dsh.send('apikey:skip'); });

function setBusy(busy) {
  save.disabled = skip.disabled = key.disabled = busy;
  save.textContent = busy ? 'Checking…' : 'Save and continue';
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = key.value.trim();
  if (value.length === 0) { error.textContent = 'Paste the key.'; return; }

  setBusy(true);
  error.textContent = '';
  // The main process checks the key with DeepSeek, saves it and closes this window when it is done.
  const result = await window.dsh.invoke('apikey:save', value);
  if (result !== 'saved') {
    error.textContent = result;
    setBusy(false);
    key.focus();
  }
});
