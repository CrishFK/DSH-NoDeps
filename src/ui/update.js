const label = document.getElementById('label');
const bar = document.getElementById('bar');
const cancel = document.getElementById('cancel');

cancel.addEventListener('click', () => {
  cancel.disabled = true;
  window.dsh.send('update:cancel');
});

window.dsh.on('update:progress', ({ text, percent, done }) => {
  label.textContent = text;
  if (percent === null) bar.removeAttribute('value');
  else { bar.max = 100; bar.value = percent; }
  if (done) cancel.disabled = true;
});
