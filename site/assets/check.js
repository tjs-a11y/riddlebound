// Checks an answer against salted SHA-256 hashes. The page never contains the answer itself.
(function(){
  const f=document.getElementById('f'),a=document.getElementById('a'),m=document.getElementById('msg'),w=document.getElementById('win');
  const norm=s=>s.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/g,'');
  async function hash(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
  let tries=0;
  f.onsubmit=async e=>{
    e.preventDefault();
    const v=norm(a.value);
    if(!v){m.className='msg no';m.textContent='Type your answer first.';return}
    if(!window.crypto||!crypto.subtle){m.className='msg no';m.textContent='Your browser can\'t check answers here. Try a newer browser.';return}
    const h=await hash(C.salt+':'+v);
    if(C.hashes.includes(h)){m.className='msg ok';m.textContent='';w.hidden=false;a.disabled=true;f.querySelector('button').disabled=true}
    else{tries++;m.className='msg no';m.textContent=tries<3?'Not it. Count the letters and try again.':'Not it. The hints at the back of the book will get you there.'}
  };
})();
