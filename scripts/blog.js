 (function() {
   var article = document.querySelector('article');
   
   // Curl straight quotes/apostrophes into typographic ones, text-only.
   function curlQuotes(str) {
     return str
       // opening double: start of string, or after whitespace / ( [ { - — /
       .replace(/(^|[\s\-\u2014([{/])"/g, '$1\u201c')
       // opening single: same contexts
       .replace(/(^|[\s\-\u2014([{/])'/g, '$1\u2018')
       // anything left is a closing quote or an apostrophe (contraction, possessive)
       .replace(/"/g, '\u201d')
       .replace(/'/g, '\u2019');
   }
   
   function smartenQuotes(root) {
     var skip = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, INPUT: 1 };
     var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
       acceptNode: function(node) {
         var parentTag = node.parentNode && node.parentNode.tagName;
         if (parentTag && skip[parentTag]) return NodeFilter.FILTER_REJECT;
         return /['"]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
       }
     });
     
     var node;
     while ((node = walker.nextNode())) {
       node.nodeValue = curlQuotes(node.nodeValue);
     }
   }
   
   smartenQuotes(article);
   
   var headings = Array.prototype.slice.call(article.querySelectorAll('h2'));
   var tocList = document.getElementById('toc-list');
   var tocLabel = document.querySelector('[data-toc-label]');
   var backdrop = document.getElementById('toc-backdrop');
   var tocButton = document.querySelector('[data-action="toc"]');
   var defaultLabel = tocLabel.textContent;
   
   function slugify(text, index) {
     var base = text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
     return base || ('section-' + (index + 1));
   }
   
   // Build TOC entries and make sure every heading has an id to scroll to.
   headings.forEach(function(h, index) {
     if (!h.id) h.id = slugify(h.textContent, index);
     
     var li = document.createElement('li');
     var btn = document.createElement('button');
     btn.type = 'button';
     btn.textContent = h.textContent;
     btn.dataset.target = h.id;
     li.appendChild(btn);
     tocList.appendChild(li);
   });
   
   var tocButtons = Array.prototype.slice.call(tocList.querySelectorAll('button'));
   
   function openToc() {
     backdrop.classList.add('is-open');
     tocButton.setAttribute('aria-expanded', 'true');
     document.body.style.overflow = 'hidden';
   }
   
   function closeToc() {
     backdrop.classList.remove('is-open');
     tocButton.setAttribute('aria-expanded', 'false');
     document.body.style.overflow = '';
   }
   
   tocButton.addEventListener('click', function() {
     backdrop.classList.contains('is-open') ? closeToc() : openToc();
   });
   
   document.querySelector('[data-action="toc-close"]').addEventListener('click', closeToc);
   
   backdrop.addEventListener('click', function(e) {
     if (e.target === backdrop) closeToc();
   });
   
   document.addEventListener('keydown', function(e) {
     if (e.key === 'Escape' && backdrop.classList.contains('is-open')) closeToc();
   });
   
   tocList.addEventListener('click', function(e) {
     var btn = e.target.closest('button[data-target]');
     if (!btn) return;
     var target = document.getElementById(btn.dataset.target);
     closeToc();
     if (target) {
       window.setTimeout(function() {
         target.scrollIntoView({ behavior: 'smooth', block: 'start' });
       }, 10);
     }
   });
   
   // Back to top
   document.querySelector('[data-action="top"]').addEventListener('click', function() {
     window.scrollTo({ top: 0, behavior: 'smooth' });
   });
   
   // Share: native share sheet, with copy-link fallback
   var shareToast = document.getElementById('share-toast');
   var toastTimer;
   
   function showToast(message) {
     shareToast.textContent = message;
     shareToast.classList.add('is-visible');
     window.clearTimeout(toastTimer);
     toastTimer = window.setTimeout(function() {
       shareToast.classList.remove('is-visible');
     }, 2200);
   }
   
   document.querySelector('[data-action="share"]').addEventListener('click', function() {
     var shareData = {
       title: document.title,
       url: window.location.href
     };
     
     if (navigator.share) {
       navigator.share(shareData).catch(function() { /* user cancelled, no-op */ });
       return;
     }
     
     if (navigator.clipboard && navigator.clipboard.writeText) {
       navigator.clipboard.writeText(shareData.url)
         .then(function() { showToast('Link copied'); })
         .catch(function() { showToast('Copy this page\u2019s URL from your browser bar'); });
     } else {
       showToast('Copy this page\u2019s URL from your browser bar');
     }
   });
   
   // Scrollspy: swap the "Contents" label for the section currently in view
   if ('IntersectionObserver' in window && headings.length) {
     var sectionMap = {};
     
     var observer = new IntersectionObserver(function(entries) {
       entries.forEach(function(entry) {
         if (entry.isIntersecting) {
           var heading = sectionMap[entry.target.id];
           if (heading) {
             tocLabel.textContent = heading.textContent;
             tocButtons.forEach(function(btn) {
               btn.setAttribute('aria-current', btn.dataset.target === heading.id ? 'true' : 'false');
             });
           }
         }
       });
     }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
     
     headings.forEach(function(h) {
       sectionMap[h.id] = h;
       observer.observe(h);
     });
     
     // Reset to the default label when scrolled above the first section
     var topSentinel = document.createElement('div');
     topSentinel.style.position = 'absolute';
     topSentinel.style.top = '0';
     topSentinel.style.height = '1px';
     topSentinel.style.width = '1px';
     article.parentNode.insertBefore(topSentinel, article);
     
     new IntersectionObserver(function(entries) {
       if (entries[0].isIntersecting) {
         tocLabel.textContent = defaultLabel;
         tocButtons.forEach(function(btn) { btn.removeAttribute('aria-current'); });
       }
     }, { rootMargin: '0px 0px -95% 0px' }).observe(topSentinel);
   }
   
   // Get the full 4-digit year from the system clock
   const year = new Date().getFullYear();
   document.getElementById('current-year').textContent = year;
   
 })();