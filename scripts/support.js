(function() {
  // Swap these for your real payment links. No amount is pre-filled —
  // the person chooses how much to give on Ko-fi's / PayPal's own page.
  const PAYMENT_URLS = {
    kofi: 'https://ko-fi.com/omniswa',
    paypal: 'https://paypal.me/yourusername'
  };
  
  const methodRow = document.getElementById('methodRow');
  const methodButtons = Array.from(methodRow.querySelectorAll('.method-btn'));
  const giveBtn = document.getElementById('giveBtn');
  
  let method = 'kofi'; // matches the method button marked active by default below
  
  function setActiveButton(list, btn) {
    list.forEach(b => b.classList.toggle('active', b === btn));
  }
  
    function setMethod(value) {
      if (!PAYMENT_URLS[value]) return;
      method = value;
      methodButtons.forEach((b) => {
        const on = b.dataset.method === value;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      giveBtn.href = PAYMENT_URLS[value];
      giveBtn.target = "_blank";
      giveBtn.rel = "noopener noreferrer";
    }
  
  methodButtons.forEach(btn => {
    btn.addEventListener('click', () => setMethod(btn.dataset.method, btn));
  });
  
  giveBtn.addEventListener('click', (e) => {
    const url = PAYMENT_URLS[method];
    if (!url || url.includes('example.com') || url.includes('yourusername')) {
      e.preventDefault();
      alert('Add your real ' + (method === 'paypal' ? 'PayPal' : 'Ko-fi') + ' link in PAYMENT_URLS in support.js first.');
    } else {
      giveBtn.target = '_blank';
      giveBtn.rel = 'noopener';
    }
  });
  
  // default selection: Ko-fi
  const defaultMethodBtn = methodButtons.find(b => b.dataset.method === 'kofi');
  if (defaultMethodBtn) setMethod('kofi', defaultMethodBtn);
})();